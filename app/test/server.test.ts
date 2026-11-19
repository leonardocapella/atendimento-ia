import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.ts';

const ok = async () => 1;
const fail = async () => { throw new Error('down'); };

test('webhook: 401 com segredo errado, 200 com o certo', async () => {
  process.env.WEBHOOK_SECRET = 'abc123';
  const app = buildApp({ pingDb: ok, pingRedis: ok });
  const bad = await app.inject({ method: 'POST', url: '/hooks/chatwoot/errado', payload: {} });
  const good = await app.inject({ method: 'POST', url: '/hooks/chatwoot/abc123', payload: { event: 'message_created' } });
  assert.equal(bad.statusCode, 401);
  assert.equal(good.statusCode, 200);
  await app.close();
});

test('webhook: sem WEBHOOK_SECRET recusa tudo', async () => {
  delete process.env.WEBHOOK_SECRET;
  const app = buildApp({ pingDb: ok, pingRedis: ok });
  const r = await app.inject({ method: 'POST', url: '/hooks/chatwoot/', payload: {} });
  assert.notEqual(r.statusCode, 200);
  await app.close();
});

test('health: 200 com deps ok, 503 com banco ou redis fora', async () => {
  for (const [db, rd, code] of [[ok, ok, 200], [fail, ok, 503], [ok, fail, 503]] as const) {
    const app = buildApp({ pingDb: db, pingRedis: rd });
    assert.equal((await app.inject('/health')).statusCode, code);
    await app.close();
  }
});

test('log do processo real nunca contém o segredo do webhook', async () => {
  const { spawn } = await import('node:child_process');
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['src/server.ts'], {
    env: { ...process.env, PORT: String(port), WEBHOOK_SECRET: 'segredo-xyz', DATABASE_URL: 'postgres://x@127.0.0.1:1/x', REDIS_URL: 'redis://127.0.0.1:1' },
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 50 && !out.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  await fetch(`http://127.0.0.1:${port}/hooks/chatwoot/segredo-xyz`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await new Promise((r) => setTimeout(r, 200));
  child.kill('SIGTERM');
  assert.ok(out.includes('/hooks/chatwoot/[redacted]'), out);
  assert.ok(!out.includes('segredo-xyz'), out);
});
