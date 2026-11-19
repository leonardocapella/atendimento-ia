-- Revisão F1. DOWN: app/db-down/003_revisao.sql
-- Handoff encerrado sem resposta humana (conversa resolvida) não pode ficar "aberto".
ALTER TABLE handoff_events ADD COLUMN encerrado_em timestamptz;
DROP INDEX handoff_abertos;
CREATE INDEX handoff_abertos ON handoff_events (tenant_id, chatwoot_conversation_id)
  WHERE primeira_resposta_em IS NULL AND encerrado_em IS NULL;

-- Varredura do claim: due_at + lease. Sem now() no predicado (Postgres recusa).
DROP INDEX timers_vencendo;
CREATE INDEX timers_vencendo ON timers (due_at, locked_until) WHERE done_at IS NULL;
