# Atendimento IA

Substituto grátis e auto-hospedado do FabChat para a EBM. O Chatwoot cuida da inbox. Um app Node (API + worker) qualifica o lead e passa o quente para o Lorenzo, com SLA.

WhatsApp do número atual: Evolution por QR (`docker-compose.qr.yml`). Testes rodam sem Docker (PGlite).

Deploy completo, variáveis, backup e monitor: [docs/DEPLOY.md](docs/DEPLOY.md).

## Testar neste computador

Não precisa de Docker.

```bash
cd app && npm install && npm test
```

## Subir local (com Docker)

```bash
cp .env.example .env
# hex: openssl rand -hex 24  (POSTGRES, REDIS, BRAIN_DB, WEBHOOK_SECRET)
# CHATWOOT_SECRET_KEY_BASE: openssl rand -hex 64
# MASTER_KEY: openssl rand -hex 32
# QR: EVOLUTION_API_KEY e EVOLUTION_DB_PASSWORD também, antes da 1ª subida
docker compose -f docker-compose.yml -f docker-compose.qr.yml up -d --build
```

1. Espere o log do Chatwoot (`Listening on http://0.0.0.0:3000`).
2. Abra http://localhost:3000 e crie o admin. `https://chat.localhost` e `https://painel.localhost` passam pelo Caddy.
3. Webhooks (bot + conta) em `http://api:8080/hooks/chatwoot/<WEBHOOK_SECRET>`. Eventos: `message_created`, `message_updated`, `conversation_updated`.
4. Parear o QR: passos em [docs/DEPLOY.md](docs/DEPLOY.md) (seção 7). Risco de banimento do número.

Sem QR (só Chatwoot e painel): `docker compose up -d --build`.

## Produção

Siga [docs/DEPLOY.md](docs/DEPLOY.md) na ordem. Resumo:

1. VPS 4–6 GB, portas 22/80/443, `.env` preenchido, `SEED_DEMO` vazio.
2. `docker compose -f docker-compose.yml -f docker-compose.qr.yml up -d --build`.
3. Admin do Chatwoot por túnel SSH **antes** de apontar o DNS.
4. DNS, tokens do bot e do admin, YAML com o ID real do Lorenzo, `users_map`.
5. QR, backup no cron (`./ops/backup.sh`), `HEALTHCHECK_URL`, UptimeRobot, regra de `pending` (`ops/chatwoot-pending.md`).

`LLM_APPROVED_FOR_PRODUCTION` fica `false` até escolher o modelo. Agente `live` não sobe sem isso.

## O que ainda depende do Leonardo

Lista fechada em [DECISOES-PENDENTES.md](DECISOES-PENDENTES.md): modelo de IA, 30 conversas do FabChat, número do gestor, healthchecks.io, Cloud API ou QR, ID do Lorenzo e textos reais do YAML.
