// Painel F1: login por access token do Chatwoot (OV-F11), config só leitura e playground.
// Sessão = cookie assinado com HMAC (chave derivada da MASTER_KEY), sem estado no servidor.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { systemPrompt, type Config } from './agent/config.ts';
import { llmEnv, type Chat } from './agent/llm.ts';
import type { Query } from './db.ts';

type Profile = { id: number; accounts: { id: number; role: string }[] };
export type PanelDeps = {
  query: Query;
  config: { config: Config; hash: string };
  chat?: Chat;                                            // ausente = LLM não configurado
  fetchProfile: (token: string) => Promise<Profile | null>;
};
type Session = { t: number; u: number; r: string; exp: number };

const TTL_S = 12 * 3600;
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

export async function chatwootProfile(token: string): Promise<Profile | null> {
  const r = await fetch(`${process.env.CHATWOOT_URL ?? 'http://chatwoot:3000'}/api/v1/profile`, {
    headers: { api_access_token: token }, signal: AbortSignal.timeout(5000),
  });
  return r.ok ? r.json() : null;
}

function sessionKey() {
  const mk = process.env.MASTER_KEY ?? '';
  if (mk.length < 32) throw new Error('MASTER_KEY ausente ou curta (openssl rand -hex 32)');
  return createHmac('sha256', mk).update('painel-sessao-v1').digest();
}
const sign = (body: string) => createHmac('sha256', sessionKey()).update(body).digest('base64url');

function encode(s: Session) {
  const body = Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${body}.${sign(body)}`;
}
function decode(cookie?: string): Session | null {
  const [body, mac] = (cookie ?? '').split('.');
  if (!body || !mac) return null;
  const a = Buffer.from(mac), b = Buffer.from(sign(body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const s: Session = JSON.parse(Buffer.from(body, 'base64url').toString());
  return s.exp > Date.now() / 1000 ? s : null;
}
const cookieOf = (req: FastifyRequest) => req.headers.cookie?.match(/(?:^|;\s*)sessao=([^;]+)/)?.[1];
const setCookie = (v: string, maxAge: number) => `sessao=${v}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

// Papel do Chatwoot vira o padrão; users_map (gestor, etc.) tem prioridade.
const ROLE = { administrator: 'admin', agent: 'atendente' } as Record<string, string>;

export async function panel(app: FastifyInstance, deps: PanelDeps) {
  await app.register(rateLimit, { global: false });
  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  const auth = (roles: string[]) => async (req: FastifyRequest, reply: any) => {
    const s = decode(cookieOf(req));
    if (!s) return reply.code(401).send({ erro: 'faça login' });
    if (!roles.includes(s.r)) return reply.code(403).send({ erro: 'sem permissão' });
    (req as any).sessao = s;
  };

  app.get('/', async (_req, reply) => reply.type('text/html').header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'").send(html));

  app.post('/api/login', limit(10), async (req, reply) => {
    const body = z.object({ token: z.string().min(10).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ erro: 'token inválido' });
    const profile = await deps.fetchProfile(body.data.token).catch(() => null);
    if (!profile) return reply.code(401).send({ erro: 'token recusado pelo Chatwoot' });

    const accountId = deps.config.config.chatwoot_account_id;
    const acc = profile.accounts?.find((a) => a.id === accountId);
    const [tenant] = await deps.query('SELECT id FROM tenants WHERE chatwoot_account_id = $1', [accountId]);
    if (!acc || !tenant) return reply.code(403).send({ erro: 'usuário sem acesso a esta conta' });
    const [mapped] = await deps.query('SELECT role FROM users_map WHERE tenant_id = $1 AND chatwoot_user_id = $2', [tenant.id, profile.id]);
    const r = mapped?.role ?? ROLE[acc.role] ?? 'atendente';

    req.log.info({ user: profile.id, role: r }, 'login no painel');   // nunca o token
    const s: Session = { t: tenant.id, u: profile.id, r, exp: Math.floor(Date.now() / 1000) + TTL_S };
    return reply.header('set-cookie', setCookie(encode(s), TTL_S)).send({ papel: r });
  });

  app.post('/api/logout', async (_req, reply) => reply.header('set-cookie', setCookie('', 0)).send({ ok: true }));

  app.get('/api/me', { preHandler: auth(['admin', 'gestor', 'atendente']) }, async (req) => {
    const s = (req as any).sessao as Session;
    return { user_id: s.u, papel: s.r };
  });

  // Só leitura no F1: editar = mudar config/ebm.yaml e reiniciar (D3).
  app.get('/api/config', { preHandler: auth(['admin', 'gestor']) }, async () => {
    const { config, hash } = deps.config, llm = llmEnv();
    return {
      versao: hash,
      llm: { configurado: Boolean(deps.chat), base_url: llm.baseUrl, modelo: llm.model, aprovado_para_producao: llm.approved },
      agentes: Object.fromEntries(Object.entries(config.agentes).map(([k, a]) => [k, { ...a, prompt: systemPrompt(a) }])),
    };
  });

  // Playground: conversa de teste, nada vai ao Chatwoot nem ao banco.
  const Play = z.object({
    agente: z.string(),
    mensagens: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) })).min(1).max(40),
  });
  app.post('/api/playground', { preHandler: auth(['admin', 'gestor']), ...limit(20) }, async (req, reply) => {
    const body = Play.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ erro: 'mensagens inválidas' });
    const agent = deps.config.config.agentes[body.data.agente];
    if (!agent) return reply.code(404).send({ erro: 'agente não existe' });
    if (!deps.chat) return reply.code(503).send({ erro: 'LLM não configurado (LLM_BASE_URL e LLM_MODEL no .env)' });
    try {
      return { resposta: await deps.chat([{ role: 'system', content: systemPrompt(agent) }, ...body.data.mensagens]) };
    } catch (e: any) {
      req.log.warn({ err: e.message }, 'playground: falha do LLM');
      return reply.code(502).send({ erro: 'o LLM não respondeu' });
    }
  });
}
