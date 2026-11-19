import Fastify from 'fastify';
import pg from 'pg';
import Redis from 'ioredis';
import { secretOk, eventMeta } from './hooks.ts';
import { panel, chatwootProfile, type PanelDeps } from './panel.ts';
import { loadConfig } from './agent/config.ts';
import { llmEnv, openaiChat } from './agent/llm.ts';
import { pgDb } from './db.ts';
import { onEvent, ensureTenant } from './conversation.ts';

type Ping = () => Promise<unknown>;
type Hook = (body: unknown) => Promise<string>;

// Deps injetáveis só para teste; produção usa Postgres/Redis reais.
export function buildApp(deps?: { pingDb: Ping; pingRedis: Ping; panel?: PanelDeps; hook?: Hook }) {
  const app = Fastify({
    bodyLimit: 1_000_000,
    logger: {
      // a URL do webhook contém o segredo: nunca logar o path cru
      serializers: { req: (r) => ({ method: r.method, url: r.url.replace(/\/hooks\/chatwoot\/[^/?]+/, '/hooks/chatwoot/[redacted]') }) },
    },
  });

  let pingDb = deps?.pingDb, pingRedis = deps?.pingRedis, hook = deps?.hook;
  if (!pingDb || !pingRedis) {
    const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    db.on('error', (e) => app.log.error({ err: e.message }, 'pg pool error')); // evita crash quando o Postgres reinicia
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 3000 });
    redis.on('error', () => {}); // o status vai no /health; não derruba o processo
    pingDb = () => db.query('select 1');
    pingRedis = async () => { if (redis.status !== 'ready') await redis.connect().catch(() => {}); return redis.ping(); };
    app.addHook('onClose', async () => { await db.end(); redis.disconnect(); });

    const llm = llmEnv(), config = loadConfig();   // config inválida derruba a subida com a linha do erro
    const pdb = pgDb(db);
    let tenant: Promise<number> | undefined;   // resolvido no 1º evento: o banco pode subir depois do api
    hook = async (body) => onEvent({ db: pdb, cfg: config.config, tenantId: await (tenant ??= ensureTenant(pdb.q, config.config.chatwoot_account_id).catch((e) => { tenant = undefined; throw e; })) }, body);
    const panelDeps: PanelDeps = {
      query: pdb.q,
      config,
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
    // só metadados no log; erro = 500 e o Chatwoot reenvia (o dedupe segura a repetição)
    const r = hook ? await hook(req.body) : 'sem handler';
    req.log.info({ ev: eventMeta(req.body), r }, 'chatwoot event');
    return { ok: true };
  });

  return app;
}

if (import.meta.main) {
  const app = buildApp();
  await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.once(s, () => app.close().then(() => process.exit(0)));
}
