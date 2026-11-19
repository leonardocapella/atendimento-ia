import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { buildApp } from '../src/server.ts';
import { loadConfig, parseConfig } from '../src/agent/config.ts';
import type { PanelDeps } from '../src/panel.ts';

process.env.MASTER_KEY = 'a'.repeat(64);
const ok = async () => 1;
const yamlText = readFileSync(new URL('../config/ebm.yaml', import.meta.url), 'utf8');

// tokens fictícios: admin da conta 1, agente da conta 1, usuário de outra conta
const profiles: Record<string, any> = {
  'tok-admin-123': { id: 1, accounts: [{ id: 1, role: 'administrator' }] },
  'tok-agent-123': { id: 2, accounts: [{ id: 1, role: 'agent' }] },
  'tok-outra-123': { id: 9, accounts: [{ id: 5, role: 'administrator' }] },
};

function make(over: Partial<PanelDeps> = {}) {
  const seen: unknown[][] = [];
  const deps: PanelDeps = {
    query: async (sql) => (sql.includes('FROM tenants') ? [{ id: 7 }] : []),
    config: loadConfig(),
    chat: async (m) => { seen.push(m); return 'Olá! Eu sou a Malu.'; },
    fetchProfile: async (t) => profiles[t] ?? null,
    ...over,
  };
  return { app: buildApp({ pingDb: ok, pingRedis: ok, panel: deps }), seen };
}
async function login(app: any, token: string) {
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { token } });
  return { status: r.statusCode, cookie: String(r.headers['set-cookie'] ?? '').split(';')[0] };
}

test('config: o exemplo versionado é válido e o hash muda com o texto', () => {
  const a = parseConfig(yamlText), b = parseConfig(yamlText + '\n# x');
  assert.ok(a.config.agentes.vendas);
  assert.notEqual(a.hash, b.hash);
});

test('config: erros apontam o caminho do campo', () => {
  const cases: [(v: any) => void, RegExp][] = [
    [(v) => delete v.comportamento.nome, /vendas\.comportamento\.nome/],
    [(v) => (v.horario.dias.seg = [['18:00', '08:00']]), /horario\.dias\.seg/],
    [(v) => (v.regras.transbordo.lead_quente.campos_obrigatorios = ['orcamento']), /"orcamento" não existe/],
    [(v) => (v.horario.responder_fora_do_horario = false), /msg_ausencia/],
  ];
  for (const [mutate, re] of cases) {
    const bad = parse(yamlText);
    mutate(bad.agentes.vendas);
    assert.throws(() => parseConfig(stringify(bad)), re);
  }
});

test('login: token recusado = 401, outra conta = 403, sem sessão = 401', async () => {
  const { app } = make();
  assert.equal((await login(app, 'tok-invalido-1')).status, 401);
  assert.equal((await login(app, 'tok-outra-123')).status, 403);
  assert.equal((await app.inject('/api/config')).statusCode, 401);
  await app.close();
});

test('login: admin vê config; atendente não vê config nem playground', async () => {
  const { app } = make();
  const admin = await login(app, 'tok-admin-123');
  assert.equal(admin.status, 200);
  const cfg = await app.inject({ url: '/api/config', headers: { cookie: admin.cookie } });
  assert.equal(cfg.statusCode, 200);
  assert.match(cfg.json().agentes.vendas.prompt, /Malu/);

  const agent = await login(app, 'tok-agent-123');
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: agent.cookie } })).json().papel, 'atendente');
  assert.equal((await app.inject({ url: '/api/config', headers: { cookie: agent.cookie } })).statusCode, 403);
  const play = await app.inject({ method: 'POST', url: '/api/playground', headers: { cookie: agent.cookie }, payload: { agente: 'vendas', mensagens: [{ role: 'user', content: 'oi' }] } });
  assert.equal(play.statusCode, 403);
  await app.close();
});

test('login: papel do users_map vale mais que o do Chatwoot', async () => {
  const { app } = make({ query: async (sql) => (sql.includes('FROM tenants') ? [{ id: 7 }] : [{ role: 'gestor' }]) });
  const s = await login(app, 'tok-agent-123');
  assert.equal((await app.inject({ url: '/api/me', headers: { cookie: s.cookie } })).json().papel, 'gestor');
  await app.close();
});

test('sessão: cookie adulterado é recusado; cookie é HttpOnly e Secure', async () => {
  const { app } = make();
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { token: 'tok-agent-123' } });
  assert.match(String(r.headers['set-cookie']), /HttpOnly; Secure; SameSite=Strict/);
  const [body, mac] = String(r.headers['set-cookie']).split(';')[0].slice('sessao='.length).split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), r: 'admin' })).toString('base64url');
  assert.equal((await app.inject({ url: '/api/config', headers: { cookie: `sessao=${forged}.${mac}` } })).statusCode, 401);
  await app.close();
});

test('playground: usa o prompt do agente e devolve a resposta', async () => {
  const { app, seen } = make();
  const { cookie } = await login(app, 'tok-admin-123');
  const r = await app.inject({ method: 'POST', url: '/api/playground', headers: { cookie }, payload: { agente: 'vendas', mensagens: [{ role: 'user', content: 'oi' }] } });
  assert.equal(r.json().resposta, 'Olá! Eu sou a Malu.');
  assert.match((seen[0][0] as any).content, /Você é Malu/);
  assert.deepEqual(seen[0][1], { role: 'user', content: 'oi' });

  const naoExiste = await app.inject({ method: 'POST', url: '/api/playground', headers: { cookie }, payload: { agente: 'x', mensagens: [{ role: 'user', content: 'oi' }] } });
  assert.equal(naoExiste.statusCode, 404);
  await app.close();
});

test('playground: sem LLM = 503; LLM falhando = 502 sem derrubar o app', async () => {
  for (const [chat, code] of [[undefined, 503], [async () => { throw new Error('LLM respondeu 500'); }, 502]] as const) {
    const { app } = make({ chat: chat as any });
    const { cookie } = await login(app, 'tok-admin-123');
    const r = await app.inject({ method: 'POST', url: '/api/playground', headers: { cookie }, payload: { agente: 'vendas', mensagens: [{ role: 'user', content: 'oi' }] } });
    assert.equal(r.statusCode, code);
    await app.close();
  }
});

test('login: rate limit de 10 por minuto', async () => {
  const { app } = make();
  let last = 0;
  for (let i = 0; i < 11; i++) last = (await login(app, 'tok-invalido-1')).status;
  assert.equal(last, 429);
  await app.close();
});
