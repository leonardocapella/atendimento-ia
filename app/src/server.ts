import Fastify from 'fastify';
import pg from 'pg';
import Redis from 'ioredis';
import { secretOk, eventMeta } from './hooks.ts';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
// ponytail: logger sem redaction custom; F0 só loga metadados. Adicionar redact de body ao entrar conteúdo no F1.
const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

app.get('/health', async (_req, reply) => {
  try {
    await db.query('select 1');
    if (redis.status !== 'ready') await redis.connect().catch(() => {});
    await redis.ping();
    return { ok: true };
  } catch {
    return reply.code(503).send({ ok: false });
  }
});

app.post<{ Params: { secret: string } }>('/hooks/chatwoot/:secret', async (req, reply) => {
  if (!secretOk(req.params.secret, process.env.WEBHOOK_SECRET ?? '')) {
    req.log.warn({ route: 'chatwoot-hook' }, 'webhook sem segredo válido');
    return reply.code(401).send();
  }
  req.log.info({ spike: eventMeta(req.body) }, 'chatwoot event');
  return { ok: true };
});

app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8080) });
