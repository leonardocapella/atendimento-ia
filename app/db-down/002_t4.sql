-- DOWN de 002_t4.sql.
ALTER TABLE timers DROP COLUMN IF EXISTS tentativas;
ALTER TABLE timers DROP COLUMN IF EXISTS locked_until;
ALTER TABLE conversation_state DROP COLUMN IF EXISTS ausencia_em;
ALTER TABLE conversation_state DROP COLUMN IF EXISTS audios_pedidos;
DROP INDEX IF EXISTS outbound_por_msg;
ALTER TABLE outbound_sends DROP COLUMN IF EXISTS chatwoot_message_id;
ALTER TABLE outbound_sends DROP CONSTRAINT IF EXISTS outbound_sends_status_check;
ALTER TABLE outbound_sends ADD CONSTRAINT outbound_sends_status_check CHECK (status IN ('pending', 'sent', 'failed'));
DELETE FROM timers WHERE kind IN ('reply', 'handoff');
ALTER TABLE timers DROP CONSTRAINT IF EXISTS timers_kind_check;
ALTER TABLE timers ADD CONSTRAINT timers_kind_check CHECK (kind IN ('sla1', 'sla2', 'followup', 'reativar', 'msg_espera'));
