import Fastify from 'fastify';
import pg from 'pg';
import Redis from 'ioredis';
import { secretOk, eventMeta } from './hooks.ts';
import { panel, chatwootProfile, type PanelDeps } from './panel.ts';
import { loadConfig } from './agent/config.ts';
import { llmEnv, openaiChat } from './agent/llm.ts';

type Ping = () => Promise<unknown>;

// Deps injetáveis só para teste; produção usa Postgres/Redis reais.
export function buildApp(deps?: { pingDb: Ping; pingRedis: Ping; panel?: PanelDeps }) {
  const app = Fastify({
    bodyLimit: 1_000_000,
    logger: {
      // a URL do webhook contém o segredo: nunca logar o path cru
      serializers: { req: (r) => ({ method: r.method, url: r.url.replace(/\/hooks\/chatwoot\/[^/?]+/, '/hooks/chatwoot/[redacted]') }) },
    },
  });

  let pingDb = deps?.pingDb, pingRedis = deps?.pingRedis;
  if (!pingDb || !pingRedis) {
    const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    db.on('error', (e) => app.log.error({ err: e.message }, 'pg pool error')); // evita crash quando o Postgres reinicia
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
    redis.on('error', () => {}); // o status vai no /health; não derruba o processo
    pingDb = () => db.query('select 1');
    pingRedis = async () => { if (redis.status !== 'ready') await redis.connect().catch(() => {}); return redis.ping(); };
    app.addHook('onClose', async () => { await db.end(); redis.disconnect(); });

    const llm = llmEnv();
    const panelDeps: PanelDeps = {
      query: async (sql, params) => (await db.query(sql, params)).rows,
      config: loadConfig(),   // config inválida derruba a subida com a linha do erro
      chat: llm.baseUrl && llm.model ? openaiChat(llm.baseUrl, llm.model, process.env.LLM_API_KEY) : undefined,
      fetchProfile: chatwootProfile,
    };
    app.register(async (i) => panel(i, panelDeps));
  } else if (deps.panel) {
    const p = deps.panel;
    app.register(async (i) => panel(i, p));
  }

  app.get('/health', async (_req, reply) => {
    try {
      await pingDb!();
      await pingRedis!();
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.post<{ Params: { secret: string } }>('/hooks/chatwoot/:secret', async (req, reply) => {
    if (!secretOk(req.params.secret, process.env.WEBHOOK_SECRET ?? '')) {
      req.log.warn('webhook sem segredo válido');
      return reply.code(401).send();
    }
    req.log.info({ spike: eventMeta(req.body) }, 'chatwoot event');
    return { ok: true };
  });

  return app;
}

if (import.meta.main) {
  const app = buildApp();
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.once(s, () => app.close().then(() => process.exit(0)));
}
