import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate, rollback, STAGES } from '../src/db.ts';

async function fresh() {
  const db = new PGlite();
  const run = async (sql: string) => (await db.exec(sql)).at(-1)?.rows ?? [];
  return { db, run };
}

test('migrate: aplica tudo, é idempotente e o seed roda 2x sem duplicar', async () => {
  const { db, run } = await fresh();
  assert.ok((await migrate(run, { seed: true })).length > 0);
  assert.deepEqual(await migrate(run, { seed: true }), []);
  assert.equal((await db.query<{ n: number }>('SELECT count(*)::int n FROM products')).rows[0].n, 2);
});

test('schema: estágios do banco = enum STAGES do código', async () => {
  const { db, run } = await fresh();
  await migrate(run);
  const tenant = (await db.query<{ id: number }>("INSERT INTO tenants (chatwoot_account_id, nome) VALUES (9, 't') RETURNING id")).rows[0].id;
  for (const s of STAGES) await db.query('INSERT INTO leads (tenant_id, chatwoot_contact_id, estagio) VALUES ($1, $2, $3)', [tenant, Math.random() * 1e9 | 0, s]);
  await assert.rejects(db.query('INSERT INTO leads (tenant_id, chatwoot_contact_id, estagio) VALUES ($1, 1, $2)', [tenant, 'inventado']));
});

test('schema: FK composta impede misturar tenants; timer pendente é único', async () => {
  const { db, run } = await fresh();
  await migrate(run);
  const [a, b] = (await db.query<{ id: number }>("INSERT INTO tenants (chatwoot_account_id, nome) VALUES (1,'a'),(2,'b') RETURNING id")).rows.map((r) => r.id);
  const lead = (await db.query<{ id: number }>('INSERT INTO leads (tenant_id, chatwoot_contact_id) VALUES ($1, 10) RETURNING id', [a])).rows[0].id;
  // lead do tenant A não pode ser ligado a uma conversa do tenant B
  await assert.rejects(db.query("INSERT INTO conversation_state (tenant_id, chatwoot_conversation_id, lead_id, agent_key) VALUES ($1, 1, $2, 'x')", [b, lead]));

  const timer = (due: string) => db.query("INSERT INTO timers (tenant_id, kind, ref_id, due_at) VALUES ($1, 'sla1', 5, $2)", [a, due]);
  await timer('2026-01-01');
  await assert.rejects(timer('2026-01-02'));   // já existe um pendente
  await db.query('UPDATE timers SET done_at = now()');
  await timer('2026-01-03');                    // depois de concluído, pode criar outro
});

test('schema: dedupe de webhook e de envio', async () => {
  const { db, run } = await fresh();
  await migrate(run);
  await db.query("INSERT INTO webhook_events (source, external_id) VALUES ('chatwoot', 'm1')");
  const dup = await db.query("INSERT INTO webhook_events (source, external_id) VALUES ('chatwoot', 'm1') ON CONFLICT DO NOTHING RETURNING 1");
  assert.equal(dup.rows.length, 0);

  const t = (await db.query<{ id: number }>("INSERT INTO tenants (chatwoot_account_id, nome) VALUES (1,'a') RETURNING id")).rows[0].id;
  const send = () => db.query("INSERT INTO outbound_sends (tenant_id, chatwoot_conversation_id, trigger_message_id, kind) VALUES ($1, 1, 100, 'reply')", [t]);
  await send();
  await assert.rejects(send());
});

test('rollback: desfaz a última migration e migrate reaplica', async () => {
  const { db, run } = await fresh();
  await migrate(run);
  assert.equal(await rollback(run), '004_retomada.sql');
  assert.equal((await db.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r: any) => r.name).at(-1), '003_revisao.sql');
  const cols = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'conversation_state' AND column_name = 'ia_retomada_em'");
  assert.equal(cols.rows.length, 0);
  assert.deepEqual(await migrate(run), ['004_retomada.sql']);
});

test('migrate: SQL quebrado não deixa migration pela metade', async () => {
  const { db, run } = await fresh();
  const broken = async (sql: string) => {
    if (sql.includes('CREATE TABLE tenants')) return run(sql.replace('CREATE TABLE products', 'CREATE TABLE products_x (; '));
    return run(sql);
  };
  await assert.rejects(migrate(broken), /migration 001_f1\.sql/);
  const r = await db.query("SELECT to_regclass('tenants') t");
  assert.equal(r.rows[0] && (r.rows[0] as any).t, null);
});
