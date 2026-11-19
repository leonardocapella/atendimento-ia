-- T4: fila de resposta e de transbordo na própria tabela timers (sem BullMQ): debounce = upsert do due_at,
-- lease em locked_until (job que caiu volta a rodar). Confirmação de mídia (OV-F1), regras de áudio e de ausência.
ALTER TABLE timers DROP CONSTRAINT timers_kind_check;
ALTER TABLE timers ADD CONSTRAINT timers_kind_check
  CHECK (kind IN ('reply', 'handoff', 'sla1', 'sla2', 'followup', 'reativar', 'msg_espera'));
ALTER TABLE timers ADD COLUMN locked_until timestamptz;

ALTER TABLE outbound_sends DROP CONSTRAINT outbound_sends_status_check;
ALTER TABLE outbound_sends ADD CONSTRAINT outbound_sends_status_check
  CHECK (status IN ('pending', 'sent', 'delivered', 'failed'));   -- delivered = message_updated com source_id
ALTER TABLE outbound_sends ADD COLUMN chatwoot_message_id bigint;
CREATE INDEX outbound_por_msg ON outbound_sends (tenant_id, chatwoot_message_id);

ALTER TABLE conversation_state
  ADD COLUMN audios_pedidos int NOT NULL DEFAULT 0,   -- 1º áudio pede texto; o 2º transfere
  ADD COLUMN ausencia_em timestamptz;
ALTER TABLE timers ADD COLUMN tentativas int NOT NULL DEFAULT 0;
