# Atendimento IA

Substituto self-hosted do FabChat: o **Chatwoot CE** cuida da inbox, dos canais, dos atendentes e das notificações; um **app próprio** (Node/TS: API + worker) é o agente de IA que qualifica o lead e passa o lead quente para o vendedor humano, com SLA.

Status: **F1 em andamento** (T2 banco e T3 config + painel prontos). O agente entra no F1. Plano completo: design doc aprovado (`~/.gstack/projects/atendimento-ia/`).

## Arquitetura

```
WhatsApp Cloud API / Instagram / Evolution(QR, opcional)
        │
   Chatwoot (web + sidekiq) ──webhook interno──▶ app api (Fastify)
        ▲                                         app worker (filas, SLA)
        └──────────── API do Chatwoot ◀───────────┘
   Postgres 16 + pgvector (bancos chatwoot, brain) · Redis · Caddy (TLS)
```

## Requisitos

- Docker + Docker Compose v2
- Local: 6 GB de RAM livres. VPS: **4 a 6 GB** (Chatwoot é o maior consumidor); +1 GB com o profile `qr`.
- Domínio com DNS apontando para a VPS (só em produção).

## Subir local

```bash
cp .env.example .env
# preencha TODOS os segredos em hex (eles vão dentro de URLs; base64 quebra a conexão):
#   POSTGRES_PASSWORD, REDIS_PASSWORD, BRAIN_DB_PASSWORD, WEBHOOK_SECRET: openssl rand -hex 24
#   CHATWOOT_SECRET_KEY_BASE: openssl rand -hex 64   MASTER_KEY: openssl rand -hex 32
(cd app && npm install)          # gera package-lock.json usado pelo build
docker compose up -d --build
docker compose logs -f chatwoot  # aguarde "Listening on http://0.0.0.0:3000"
```

- **1ª configuração do Chatwoot:** abra http://localhost:3000 (porta só no localhost) e crie a conta admin. Pelo domínio público, `/installation` e `/super_admin` ficam bloqueados.
- Chatwoot: https://chat.localhost (o Caddy usa um certificado local; aceite o aviso ou rode `docker compose exec caddy caddy trust`)
- Saúde do app: `docker compose ps` (o `api` deve ficar `healthy`; `/health` não é público)

## Subir em VPS

1. Instale Docker; aponte o DNS de `chat.seudominio` e `painel.seudominio` para a VPS.
2. No `.env`: `DOMAIN`, `CHATWOOT_HOST`, `PAINEL_HOST` com os domínios reais; segredos fortes.
3. **Antes de liberar o DNS/porta 443**, rode `docker compose up -d --build` e faça a 1ª configuração por túnel SSH: `ssh -L 3000:127.0.0.1:3000 usuario@vps` e abra http://localhost:3000. O Caddy emite TLS (Let's Encrypt) sozinho.
4. Firewall: libere só as portas 80/443 (e 22). Postgres, Redis, app e Evolution não são publicados.
5. **Backup** (fora da VPS: outro servidor, nuvem ou seu computador; o T10 automatiza):
   - `MASTER_KEY` e o `.env` inteiro: guarde uma cópia offline.
   - Postgres: `docker compose exec -T postgres pg_dumpall -U postgres | gzip > backups/$(date +%F).sql.gz`
   - Mídias do Chatwoot: `docker run --rm -v atendimento-ia_chatwoot-storage:/s -v $PWD/backups:/b alpine tar czf /b/storage-$(date +%F).tgz -C /s .`
   - Teste o restore pelo menos uma vez. O `init.sh` do Postgres só roda em volume vazio; um restore via `pg_dumpall` recria os bancos e os usuários.
6. Logs dos containers têm limite (10 MB × 3 por serviço), para o disco não encher.

## Conectar o Chatwoot ao app

Dentro do Chatwoot (como admin), configure dois webhooks:
- **Agent Bot** (Configurações > Bots): URL `http://api:8080/hooks/chatwoot/<WEBHOOK_SECRET>`
- **Webhook da conta** (Configurações > Integrações > Webhooks): mesma URL; eventos `message_created`, `message_updated`, `conversation_updated`.

A URL usa a rede interna do compose; o Caddy bloqueia `/hooks/*` de fora.

## WhatsApp

- **Recomendado: Cloud API oficial** (Chatwoot > Inboxes > WhatsApp > WhatsApp Cloud). Responder dentro da janela de 24h é grátis; templates iniciados pela empresa são cobrados pela Meta.
- **Opcional: QR (Evolution/Baileys):** preencha `EVOLUTION_API_KEY` e `EVOLUTION_DB_PASSWORD` (antes da 1ª subida do Postgres) e rode `docker compose -f docker-compose.yml -f docker-compose.qr.yml up -d`. **Risco:** viola os termos do WhatsApp e pode **banir o número**, principalmente em disparos em massa. Use só em número que você aceita perder.

## Spikes do F0 (comportamento real do Chatwoot)

Com os dois webhooks configurados, faça os testes e veja `docker compose logs api | grep spike` (o log mostra só metadados, nunca o conteúdo):

| Spike | Teste | O que observar |
|---|---|---|
| R4 | Atendente humano responde a uma conversa | chega `message_created` com `message_type=outgoing`, `sender_type=user`? Por qual webhook? |
| OV-F1 | Enviar uma imagem para um número de teste | `message_updated` posterior com `has_source_id=true` ou `status=failed`? Quanto tempo depois? |
| OV-F6 | Mensagem enviada pelo token do bot vs token de admin | `sender_type` = `agent_bot` vs `user`; qual token consegue atribuir uma conversa? |

Anote os resultados no plano antes do F1.

## Banco do app (brain)

- Migrations em `app/migrations/*.sql`, aplicadas em ordem pelo `api` ao subir (`node src/db.ts`), cada arquivo numa transação. Já aplicadas ficam em `schema_migrations`.
- `SEED_DEMO=true` no `.env` cria o tenant demo (conta Chatwoot 1), o admin (usuário 1), o "Lorenzo" fictício (usuário 2) e 2 produtos. É idempotente. Em produção, deixe vazio.
- Rodar à mão: `docker compose exec api node src/db.ts --seed`.
- Toda tabela tem `tenant_id NOT NULL` e FKs compostas por tenant. RLS entra no F1.5, antes do 2º tenant.

## Agente e painel

- **Config do agente:** `app/config/ebm.yaml` (4 etapas: comportamento, regras, conhecimento, horário). É validada na subida; um campo errado impede o app de subir e o log aponta o caminho (ex.: `agentes.vendas.comportamento.nome`). Para mudar, edite o arquivo e rode `docker compose up -d --build api worker`. O exemplo é fictício: troque pelos textos exportados do FabChat.
- **LLM:** `LLM_BASE_URL`, `LLM_MODEL` e `LLM_API_KEY` no `.env` (qualquer API compatível com OpenAI: 9router, Ollama `/v1`, Groq, Gemini). Sem eles, o playground fica desligado.
- **Painel:** https://painel.localhost. Entra com o **access token do Chatwoot** (Perfil > Configurações do perfil > Token de acesso); o app nunca vê a senha. Admin e gestor veem a config (só leitura) e o playground; atendente não. O papel vem do Chatwoot, e `users_map.role` tem prioridade (é onde se define `gestor`).
- O playground não envia nada ao cliente nem grava no banco. Com provedor não aprovado para produção, use só dados fictícios.

## Testes

```bash
cd app && npm test
```

## Segurança

- `.env` e `exemplos-erros/` (prints com telefones reais) ficam fora do git.
- Webhook valida o segredo em tempo constante; sem `WEBHOOK_SECRET`, recusa tudo. O segredo é mascarado no log.
- Cada serviço recebe só as próprias variáveis (sem `env_file`). O app e a Evolution têm usuários Postgres próprios, sem acesso ao banco do Chatwoot.
- Postgres e Redis ficam numa rede interna, sem rota para fora.
- Logs do app nunca registram o conteúdo das mensagens.
