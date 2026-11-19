// Migrations em SQL puro, aplicadas em ordem de nome, uma transação por arquivo.
// `run` executa SQL (pode ter vários comandos) e devolve as linhas do último: serve para pg e PGlite.
import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';

export type Query = (sql: string, params?: unknown[]) => Promise<any[]>;
export type Db = { q: Query; tx: <T>(fn: (q: Query) => Promise<T>) => Promise<T> };

export function pgDb(pool: pg.Pool): Db {
  return {
    q: async (sql, p) => (await pool.query(sql, p)).rows,
    tx: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(async (sql, p) => (await c.query(sql, p)).rows);
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  };
}

export const STAGES = ['novo', 'em_qualificacao', 'quente', 'em_negociacao', 'ganho', 'perdido', 'nutricao'] as const;

type Run = (sql: string) => Promise<Record<string, unknown>[]>;
const dir = new URL('../migrations/', import.meta.url);
const seedFile = new URL('../seeds/demo.sql', import.meta.url);

export async function migrate(run: Run, opts: { seed?: boolean } = {}) {
  // api e worker sobem juntos: o lock de sessão evita os dois migrando ao mesmo tempo.
  await run('SELECT pg_advisory_lock(7317)');
  try {
    await run('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await run('SELECT name FROM schema_migrations')).map((r) => r.name));
    const applied: string[] = [];
    for (const name of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      const sql = await readFile(new URL(name, dir), 'utf8');
      // nome vem do disco (só [0-9a-z_.]), não de entrada externa
      if (!/^[\w.]+$/.test(name)) throw new Error(`nome de migration inválido: ${name}`);
      await run(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${name}');\nCOMMIT;`).catch(async (e) => {
        await run('ROLLBACK').catch(() => {});
        throw new Error(`migration ${name}: ${e.message}`);
      });
      applied.push(name);
    }
    if (opts.seed) await run(await readFile(seedFile, 'utf8'));
    return applied;
  } finally {
    await run('SELECT pg_advisory_unlock(7317)');
  }
}

// Uso: DATABASE_URL=... node src/db.ts [--seed]  (ou SEED_DEMO=true)
if (import.meta.main) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const run: Run = async (sql) => { const r: any = await client.query(sql); return (Array.isArray(r) ? r.at(-1) : r).rows; };
    const applied = await migrate(run, { seed: process.argv.includes('--seed') || process.env.SEED_DEMO === 'true' });
    console.log(applied.length ? `migrations aplicadas: ${applied.join(', ')}` : 'banco já atualizado');
  } finally {
    await client.end();
  }
}
