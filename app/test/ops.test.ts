import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertFromEnv, telegramAlert } from '../src/alert.ts';
import { ping } from '../src/monitor.ts';

test('telegram: sem token não envia; com token manda o texto e corta em 4000', async () => {
  assert.equal(alertFromEnv({}), null);
  let body = '';
  const fetchFn = async (_u: string, init?: RequestInit) => { body = String(init?.body); return new Response('{}', { status: 200 }); };
  await telegramAlert('t', '1', fetchFn as typeof fetch)('a'.repeat(5000));
  assert.equal(JSON.parse(body).text.length, 4000);
  assert.equal(JSON.parse(body).chat_id, '1');
});

test('ping: URL vazia não chama a rede; falha de rede não derruba', async () => {
  let n = 0;
  const fetchFn = async () => { n++; return new Response('', { status: 200 }); };
  assert.equal(await ping('', fetchFn as typeof fetch), false);
  assert.equal(n, 0);
  assert.equal(await ping('https://hc.example/x', fetchFn as typeof fetch), true);
  assert.equal(await ping('https://hc.example/x', (async () => { throw new Error('rede'); }) as typeof fetch), false);
});
