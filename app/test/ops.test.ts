import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertFromEnv, whatsappAlert } from '../src/alert.ts';
import { ping } from '../src/monitor.ts';

test('whatsapp: sem número não envia; com a instância manda só ao gestor e corta em 4000', async () => {
  assert.equal(alertFromEnv({}), null);
  assert.equal(alertFromEnv({ EVOLUTION_URL: 'http://evolution:8080', EVOLUTION_API_KEY: 'k', EVOLUTION_INSTANCE: '../x', GESTOR_WHATSAPP: '5561999999999' }), null);
  let url = '', body = '', key = '';
  const fetchFn = async (u: string, init?: RequestInit) => {
    url = u; body = String(init?.body); key = new Headers(init?.headers).get('apikey') ?? '';
    return new Response('{}', { status: 200 });
  };
  const env = { EVOLUTION_URL: 'http://evolution:8080/', EVOLUTION_API_KEY: 'k', EVOLUTION_INSTANCE: 'ebm', GESTOR_WHATSAPP: '+55 61 99999-9999' };
  await alertFromEnv(env, fetchFn as typeof fetch)!('a'.repeat(5000));
  assert.equal(url, 'http://evolution:8080/message/sendText/ebm');
  assert.equal(key, 'k');
  assert.equal(JSON.parse(body).number, '5561999999999');
  assert.equal(JSON.parse(body).text.length, 4000);
  await assert.rejects(whatsappAlert('http://evolution:8080', 'k', 'ebm', '5561999999999', (async () => new Response('', { status: 500 })) as typeof fetch)('oi'), /Evolution respondeu 500/);
});

test('ping: URL vazia não chama a rede; falha de rede não derruba', async () => {
  let n = 0;
  const fetchFn = async () => { n++; return new Response('', { status: 200 }); };
  assert.equal(await ping('', fetchFn as typeof fetch), false);
  assert.equal(n, 0);
  assert.equal(await ping('https://hc.example/x', fetchFn as typeof fetch), true);
  assert.equal(await ping('https://hc.example/x', (async () => { throw new Error('rede'); }) as typeof fetch), false);
});
