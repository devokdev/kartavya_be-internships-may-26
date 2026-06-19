import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import http from 'node:http';

async function postJson(url, { headers, body }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('idempotency: concurrent duplicate requests create exactly one record', async () => {
  const proc = spawn('node', ['src/server.js'], { env: { ...process.env, API_KEY: 'k', PORT: '9101', RATE_LIMIT_PER_MIN: '100' } });
  await wait(1500);

  const base = 'http://127.0.0.1:9101';
  const idem = 'concurrent-key-1';

  // Send 15 duplicate requests concurrently
  const promises = [];
  for (let i = 0; i < 15; i++) {
    promises.push(postJson(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k', 'Idempotency-Key': idem },
      body: { userId: 'user_concurrent', type: 'event', payload: 'data' }
    }));
  }

  const results = await Promise.all(promises);
  proc.kill();

  const firstId = results[0].body.id;
  assert.ok(firstId, 'Should have a valid ID');

  for (const res of results) {
    assert.equal(res.status, 200);
    assert.equal(res.body.id, firstId, 'All concurrent duplicate requests must return the exact same resource ID');
  }
});

test('rate limiting: parallel requests and window reset', async () => {
  // Set rate limit to 3 per minute
  const proc = spawn('node', ['src/server.js'], { env: { ...process.env, API_KEY: 'k', PORT: '9102', RATE_LIMIT_PER_MIN: '3' } });
  await wait(1500);

  const base = 'http://127.0.0.1:9102';

  // Send 5 parallel requests
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(postJson(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'user_rate_limit', type: 'click', payload: String(i) }
    }));
  }

  const results = await Promise.all(promises);
  proc.kill();

  const statusCodes = results.map(r => r.status);
  const successCount = statusCodes.filter(c => c === 200).length;
  const limitedCount = statusCodes.filter(c => c === 429).length;

  assert.equal(successCount, 3, 'Exactly 3 requests should succeed');
  assert.equal(limitedCount, 2, 'Exactly 2 requests should be rate limited');
});

test('db failures: transient failures are recovered via retry', async () => {
  // Simulate 30% DB failure rate
  const proc = spawn('node', ['src/server.js'], {
    env: { ...process.env, API_KEY: 'k', PORT: '9103', RATE_LIMIT_PER_MIN: '10', DB_FAIL_RATE: '0.3' }
  });
  await wait(1500);

  const base = 'http://127.0.0.1:9103';

  // Send several requests sequentially to ensure they retry and succeed
  for (let i = 0; i < 5; i++) {
    const res = await postJson(`${base}/v1/signals`, {
      headers: { 'x-api-key': 'k' },
      body: { userId: 'user_db_fail', type: 'log', payload: `test-${i}` }
    });
    assert.equal(res.status, 200, 'Should recover from transient failures and succeed');
  }

  proc.kill();
});

test('db failures: retry exhaustion returns 503', async () => {
  // Force 100% DB failure rate
  const proc = spawn('node', ['src/server.js'], {
    env: { ...process.env, API_KEY: 'k', PORT: '9104', RATE_LIMIT_PER_MIN: '10', DB_FAIL_RATE: '1.0' }
  });
  await wait(1500);

  const base = 'http://127.0.0.1:9104';

  const res = await postJson(`${base}/v1/signals`, {
    headers: { 'x-api-key': 'k' },
    body: { userId: 'user_exhaust', type: 'error', payload: 'crash' }
  });

  proc.kill();

  assert.equal(res.status, 503, 'Should fail with 503 when DB is permanently unavailable');
  assert.equal(res.body.error, 'db_unavailable');
});
