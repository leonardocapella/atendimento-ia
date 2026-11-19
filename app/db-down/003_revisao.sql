-- DOWN de 003_revisao.sql.
DROP INDEX IF EXISTS timers_vencendo;
CREATE INDEX timers_vencendo ON timers (due_at) WHERE done_at IS NULL;
DROP INDEX IF EXISTS handoff_abertos;
CREATE INDEX handoff_abertos ON handoff_events (tenant_id, chatwoot_conversation_id) WHERE primeira_resposta_em IS NULL;
ALTER TABLE handoff_events DROP COLUMN IF EXISTS encerrado_em;
