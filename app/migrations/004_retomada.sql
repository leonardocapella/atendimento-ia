-- Remoção manual da etiqueta ia-pausada. DOWN: app/db-down/004_retomada.sql
ALTER TABLE conversation_state ADD COLUMN ia_retomada_em timestamptz;
