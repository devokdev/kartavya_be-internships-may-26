import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

// Enable WAL mode for high concurrency
db.pragma('journal_mode = WAL');

// schema
db.exec(`
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  last_updated INTEGER NOT NULL
);
`);

// failure simulation
function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}

// Reusable exponential backoff retry wrapper for transient DB failures
export async function withDbRetry(fn, maxRetries = 6, baseDelay = 10, maxDelay = 1000) {
  let attempt = 0;
  while (true) {
    try {
      return fn();
    } catch (err) {
      const isTransient =
        err.code === 'SQLITE_BUSY' ||
        err.code === 'SQLITE_LOCKED' ||
        err.message === 'simulated_db_failure';

      if (!isTransient || attempt >= maxRetries) {
        throw err;
      }
      attempt++;
      const delay = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
      const jitter = Math.random() * delay;
      await new Promise((resolve) => setTimeout(resolve, jitter));
    }
  }
}

export function insertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();
  const stmt = db.prepare(
    'INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
  );
  return stmt.run(userId, type, String(payload), idemKey || null, nowMs);
}

export function getByIdemKey(idemKey) {
  maybeFail();
  const stmt = db.prepare(
    'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE idempotency_key = ?'
  );
  return stmt.get(idemKey);
}

export function listSignals(userId, limit) {
  maybeFail();
  const stmt = db.prepare(
    'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
  );
  return stmt.all(userId, limit);
}

// Concurrency-safe, multi-instance token bucket logic inside an SQLite transaction
export function consumeToken(userId, limit, windowMs, nowMs) {
  maybeFail();
  const runTransaction = db.transaction(() => {
    const stmtGet = db.prepare('SELECT tokens, last_updated FROM rate_limits WHERE user_id = ?');
    const row = stmtGet.get(userId);

    if (!row) {
      const tokens = limit - 1;
      const stmtInsert = db.prepare('INSERT INTO rate_limits (user_id, tokens, last_updated) VALUES (?, ?, ?)');
      stmtInsert.run(userId, tokens, nowMs);
      return { ok: true, remaining: Math.floor(tokens), resetMs: nowMs + windowMs };
    }

    const elapsed = Math.max(0, nowMs - row.last_updated);
    const tokensToAdd = elapsed * (limit / windowMs);
    const currentTokens = Math.min(limit, row.tokens + tokensToAdd);

    if (currentTokens >= 1) {
      const nextTokens = currentTokens - 1;
      const stmtUpdate = db.prepare('UPDATE rate_limits SET tokens = ?, last_updated = ? WHERE user_id = ?');
      stmtUpdate.run(nextTokens, nowMs, userId);
      return { ok: true, remaining: Math.floor(nextTokens), resetMs: nowMs + Math.ceil((limit - nextTokens) * (windowMs / limit)) };
    } else {
      const timeToWait = (1 - currentTokens) * (windowMs / limit);
      return { ok: false, remaining: 0, resetMs: nowMs + Math.ceil(timeToWait) };
    }
  });

  return runTransaction.immediate(userId, limit, windowMs, nowMs);
}

