-- F1 (T2). Toda tabela de negócio tem tenant_id NOT NULL; RLS fica para o F1.5 (decisão D3).
-- FKs compostas (tenant_id, id) impedem ligar linhas de tenants diferentes.
-- Config do agente, perguntas de qualificação e regras de handoff vêm de config/ebm.yaml no F1 (D3), não do banco.

CREATE TABLE tenants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chatwoot_account_id bigint NOT NULL UNIQUE,
  nome text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo'
);

CREATE TABLE users_map (
  tenant_id bigint NOT NULL REFERENCES tenants,
  chatwoot_user_id bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'gestor', 'atendente')),
  horario jsonb NOT NULL DEFAULT '{}',   -- {"seg": [["09:00","18:00"]], ...}
  PRIMARY KEY (tenant_id, chatwoot_user_id)
);

-- Estágios: mesma lista do enum STAGES em src/db.ts (o teste confere).
CREATE TABLE leads (
  tenant_id bigint NOT NULL REFERENCES tenants,
  id bigint GENERATED ALWAYS AS IDENTITY,
  chatwoot_contact_id bigint NOT NULL,
  estagio text NOT NULL DEFAULT 'novo'
    CHECK (estagio IN ('novo', 'em_qualificacao', 'quente', 'em_negociacao', 'ganho', 'perdido', 'nutricao')),
  responsavel_user_id bigint,
  tags text[] NOT NULL DEFAULT '{}',
  qualificacao jsonb NOT NULL DEFAULT '{}',
  sinal_compra boolean NOT NULL DEFAULT false,
  pontuacao int NOT NULL DEFAULT 0,
  sempre_humano boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, chatwoot_contact_id),
  FOREIGN KEY (tenant_id, responsavel_user_id) REFERENCES users_map (tenant_id, chatwoot_user_id)
);

-- Dono único do estado "IA pausada" (R2): a label do Chatwoot é só espelho.
CREATE TABLE conversation_state (
  tenant_id bigint NOT NULL REFERENCES tenants,
  chatwoot_conversation_id bigint NOT NULL,
  lead_id bigint,
  agent_key text NOT NULL,              -- chave do agente no YAML
  ia_pausada boolean NOT NULL DEFAULT false,
  pausa_motivo text,
  apresentou_em timestamptz,            -- RQ1: apresentação no máximo 1 vez
  last_msg_at timestamptz,              -- debounce (OV-F12)
  last_customer_msg_at timestamptz,     -- janela de 24h (regra 9)
  tentativas_followup int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, chatwoot_conversation_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id)
);

CREATE TABLE handoff_events (
  tenant_id bigint NOT NULL REFERENCES tenants,
  id bigint GENERATED ALWAYS AS IDENTITY,
  chatwoot_conversation_id bigint NOT NULL,
  motivo text NOT NULL CHECK (motivo IN
    ('lead_quente', 'pedido_cliente', 'insatisfacao', 'pergunta_fora_do_escopo', 'falha_tecnica', 'fora_janela', 'midia_nao_suportada')),
  justificativa text,
  para_user_id bigint,
  para_team_id bigint,
  snapshot jsonb NOT NULL DEFAULT '{}',
  handoff_em timestamptz NOT NULL DEFAULT now(),
  primeira_resposta_em timestamptz,
  sla_estouros int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, chatwoot_conversation_id) REFERENCES conversation_state (tenant_id, chatwoot_conversation_id),
  CHECK (para_user_id IS NOT NULL OR para_team_id IS NOT NULL)
);
-- SLA: achar o handoff aberto da conversa (para na 1ª resposta humana).
CREATE INDEX handoff_abertos ON handoff_events (tenant_id, chatwoot_conversation_id) WHERE primeira_resposta_em IS NULL;

-- R1: timers no Postgres (SLA, follow-up, reativação); o sweeper varre a cada 30 s.
CREATE TABLE timers (
  tenant_id bigint NOT NULL REFERENCES tenants,
  id bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (kind IN ('sla1', 'sla2', 'followup', 'reativar', 'msg_espera')),
  ref_id bigint NOT NULL,               -- handoff_events.id ou chatwoot_conversation_id, conforme o kind
  due_at timestamptz NOT NULL,
  done_at timestamptz,
  PRIMARY KEY (tenant_id, id)
);
-- Só um timer pendente por (kind, ref): reagendar = upsert, nunca duplicar.
CREATE UNIQUE INDEX timers_um_pendente ON timers (tenant_id, kind, ref_id) WHERE done_at IS NULL;
CREATE INDEX timers_vencendo ON timers (due_at) WHERE done_at IS NULL;

-- Regra 3: dedupe de entrada. Sem tenant_id: a origem é global e o dedupe acontece antes de resolver o tenant.
CREATE TABLE webhook_events (
  source text NOT NULL,
  external_id text NOT NULL,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, external_id)
);
CREATE INDEX webhook_events_antigos ON webhook_events (recebido_em);   -- limpeza periódica

-- Regra 4: gravado antes do POST ao Chatwoot.
CREATE TABLE outbound_sends (
  tenant_id bigint NOT NULL REFERENCES tenants,
  chatwoot_conversation_id bigint NOT NULL,
  trigger_message_id bigint NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  brain_send_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, chatwoot_conversation_id, trigger_message_id, kind)
);

-- Sem conteúdo do cliente: só metadados da execução.
CREATE TABLE ai_runs (
  tenant_id bigint NOT NULL REFERENCES tenants,
  id bigint GENERATED ALWAYS AS IDENTITY,
  chatwoot_conversation_id bigint NOT NULL,
  agent_key text NOT NULL,
  config_hash text NOT NULL,            -- versão da config do YAML
  provedor text NOT NULL,
  modelo text NOT NULL,
  tokens_in int,
  tokens_out int,
  latencia_ms int,
  campos_extraidos text[],              -- só as chaves, não os valores
  decisao text,
  erro text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ai_runs_conversa ON ai_runs (tenant_id, chatwoot_conversation_id, criado_em);

-- OV-F7: products mínimo (enviar_midia, EV5/6/8). Embedding entra no F2.
CREATE TABLE products (
  tenant_id bigint NOT NULL REFERENCES tenants,
  id bigint GENERATED ALWAYS AS IDENTITY,
  codigo text NOT NULL,                 -- ID citado pelo cliente/catálogo
  tipo text NOT NULL DEFAULT 'produto' CHECK (tipo IN ('produto', 'servico', 'plano')),
  nome text NOT NULL,
  preco_centavos bigint CHECK (preco_centavos >= 0),
  disponivel boolean NOT NULL DEFAULT true,
  descricao text,
  imagem_url text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, codigo)
);
