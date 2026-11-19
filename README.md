# Atendimento IA

Substituto self-hosted do FabChat: o **Chatwoot CE** cuida da inbox, dos canais, dos atendentes e das notificações; um **app próprio** (Node/TS: API + worker) é o agente de IA que qualifica o lead e passa o lead quente para o vendedor humano, com SLA.

Status: **F0 (infra)**. O agente entra no F1. Plano completo: design doc aprovado (`~/.gstack/projects/atendimento-ia/`).

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
# preencha: POSTGRES_PASSWORD, REDIS_PASSWORD,
#   CHATWOOT_SECRET_KEY_BASE (openssl rand -hex 64),
#   MASTER_KEY (openssl rand -base64 32), WEBHOOK_SECRET (openssl rand -hex 24)
(cd app && npm install)          # gera package-lock.json usado pelo build
docker compose up -d --build
docker compose logs -f chatwoot  # aguarde "Listening on http://0.0.0.0:3000"
```

- Chatwoot: http://chat.localhost (crie a conta admin na primeira tela)
- App: http://painel.localhost/health → `{"ok":true}`

## Subir em VPS

1. Instale Docker; aponte o DNS de `chat.seudominio` e `painel.seudominio` para a VPS.
2. No `.env`: `DOMAIN`, `CHATWOOT_HOST`, `PAINEL_HOST` com os domínios reais; segredos fortes.
3. `docker compose up -d --build`. O Caddy emite TLS (Let's Encrypt) sozinho.
4. Firewall: libere só as portas 80/443 (e 22). Postgres, Redis, app e Evolution não são publicados.
5. **Backup:** guarde o `MASTER_KEY` fora da VPS. Backup diário do Postgres:
   `docker compose exec -T postgres pg_dumpall -U postgres | gzip > backups/$(date +%F).sql.gz`
   (automatize no cron; teste o restore pelo menos uma vez; o T10 automatiza isso).

## Conectar o Chatwoot ao app

Dentro do Chatwoot (como admin), configure dois webhooks:
- **Agent Bot** (Configurações > Bots): URL `http://api:8080/hooks/chatwoot/<WEBHOOK_SECRET>`
- **Webhook da conta** (Configurações > Integrações > Webhooks): mesma URL; eventos `message_created`, `message_updated`, `conversation_updated`.

A URL usa a rede interna do compose; o Caddy bloqueia `/hooks/*` de fora.

## WhatsApp

- **Recomendado: Cloud API oficial** (Chatwoot > Inboxes > WhatsApp > WhatsApp Cloud). Responder dentro da janela de 24h é grátis; templates iniciados pela empresa são cobrados pela Meta.
- **Opcional: QR (Evolution/Baileys)** com `docker compose --profile qr up -d`. **Risco:** viola os termos do WhatsApp e pode **banir o número**, principalmente em disparos em massa. Use só em número que você aceita perder.

## Spikes do F0 (comportamento real do Chatwoot)

Com os dois webhooks configurados, faça os testes e veja `docker compose logs api | grep spike` (o log mostra só metadados, nunca o conteúdo):

| Spike | Teste | O que observar |
|---|---|---|
| R4 | Atendente humano responde a uma conversa | chega `message_created` com `message_type=outgoing`, `sender_type=user`? Por qual webhook? |
| OV-F1 | Enviar uma imagem para um número de teste | `message_updated` posterior com `has_source_id=true` ou `status=failed`? Quanto tempo depois? |
| OV-F6 | Mensagem enviada pelo token do bot vs token de admin | `sender_type` = `agent_bot` vs `user`; qual token consegue atribuir uma conversa? |

Anote os resultados no plano antes do F1.

## Testes

```bash
cd app && npm test
```

## Segurança

- `.env` e `exemplos-erros/` (prints com telefones reais) ficam fora do git.
- Webhook valida o segredo em tempo constante; sem `WEBHOOK_SECRET`, recusa tudo.
- Logs do app nunca registram o conteúdo das mensagens.
