import { consumeToken, withDbRetry } from './db.js';

const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

export async function checkAndConsume(userId, nowMs = Date.now()) {
  return await withDbRetry(() => consumeToken(userId, RATE, WINDOW_MS, nowMs));
}

