import { insertSignal, getByIdemKey, listSignals, withDbRetry } from './db.js';
import { checkAndConsume } from './rateLimit.js';

function nowMs() {
  return Date.now();
}

export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  // 1. Fast path for idempotency check (avoids rate limit consumption on retries)
  if (idem) {
    try {
      const existing = await withDbRetry(() => getByIdemKey(idem));
      if (existing) {
        return existing;
      }
    } catch (e) {
      req.log.error({ err: e, ctx: 'getByIdemKey-initial' });
      return reply.code(503).send({ error: 'db_unavailable' });
    }
  }

  // 2. Consume rate limit
  let rateLimitResult;
  try {
    rateLimitResult = await checkAndConsume(userId, nowMs());
  } catch (e) {
    req.log.error({ err: e, ctx: 'rateLimit' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }

  const { ok, remaining, resetMs } = rateLimitResult;
  reply.header('X-RateLimit-Remaining', remaining);
  reply.header('X-RateLimit-Reset', resetMs);

  if (!ok) {
    return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });
  }

  // 3. Insert signal atomically
  const t = nowMs();
  try {
    const info = await withDbRetry(() => insertSignal(userId, type, payload, idem, t));
    return {
      id: info.lastInsertRowid,
      userId,
      type,
      payload: String(payload),
      idempotencyKey: idem,
      createdAt: t
    };
  } catch (e) {
    // Catch unique constraint violation in case of concurrent insert race
    if (idem && (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || (e.code === 'SQLITE_CONSTRAINT' && e.message.includes('UNIQUE')))) {
      try {
        const existing = await withDbRetry(() => getByIdemKey(idem));
        if (existing) {
          return existing;
        }
      } catch (innerErr) {
        req.log.error({ err: innerErr, ctx: 'getByIdemKey-fallback' });
      }
    }
    req.log.error({ err: e, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await withDbRetry(() => listSignals(userId, lim));
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

