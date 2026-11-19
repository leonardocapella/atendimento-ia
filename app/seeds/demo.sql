-- Dados de exemplo (idempotente). Tenant demo, usuários fictícios e produtos.
-- Os IDs do Chatwoot (conta 1, usuários 1 e 2) valem numa instalação nova; ajuste se forem outros.
INSERT INTO tenants (chatwoot_account_id, nome) VALUES (1, 'EBM (demo)') ON CONFLICT DO NOTHING;

INSERT INTO users_map (tenant_id, chatwoot_user_id, role, horario)
SELECT t.id, u.uid, u.role, u.horario::jsonb FROM tenants t,
  (VALUES (1, 'admin', '{}'),
          (2, 'atendente', '{"seg":[["09:00","18:00"]],"ter":[["09:00","18:00"]],"qua":[["09:00","18:00"]],"qui":[["09:00","18:00"]],"sex":[["09:00","18:00"]]}')
  ) AS u(uid, role, horario)   -- 2 = "Lorenzo" fictício
WHERE t.chatwoot_account_id = 1
ON CONFLICT DO NOTHING;

INSERT INTO products (tenant_id, codigo, tipo, nome, preco_centavos, descricao)
SELECT t.id, p.codigo, p.tipo, p.nome, p.preco, p.descricao FROM tenants t,
  (VALUES ('DEMO-001', 'produto', 'Produto exemplo A', 150000, 'Item de demonstração'),
          ('DEMO-002', 'servico', 'Instalação', 30000, 'Serviço de demonstração')
  ) AS p(codigo, tipo, nome, preco, descricao)
WHERE t.chatwoot_account_id = 1
ON CONFLICT DO NOTHING;
