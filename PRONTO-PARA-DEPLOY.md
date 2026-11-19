# Pronto para deploy

Código do F1 (T2–T10) está no repo. `cd app && npm test`: 58 testes, 0 falhas (19/11/2026, commit `ce38f4d`). Sem push. Sem Docker nesta máquina: o compose não foi subido aqui.

## Checklist

- [x] Testes do app passam sem container (PGlite).
- [x] CI: lint por `node --check`, testes, eval em aviso, build da imagem, push para GHCR na `main`.
- [x] Webhook com segredo em tempo constante. Sem `WEBHOOK_SECRET`, recusa tudo.
- [x] Fila no Postgres, dedupe de webhook e de envio, transbordo para o destino do YAML, SLA 10/30.
- [x] Alerta do gestor por WhatsApp (Evolution). Sem Telegram no código, no schema, no compose e nos docs.
- [x] Worker pinga `HEALTHCHECK_URL` no máximo 1 vez por minuto, com fila cheia ou vazia.
- [x] Backup: `ops/backup.sh` (dump) e `--restore-test`. Regra de `pending`: `ops/chatwoot-pending.md`.
- [x] Deploy escrito: `docs/DEPLOY.md`. README curto.
- [ ] Subir o compose numa VPS (esta máquina não tem Docker).
- [ ] Preencher o `.env` de produção e guardar `MASTER_KEY` fora da VPS.
- [ ] Criar o admin do Chatwoot por túnel SSH antes do DNS.
- [ ] Webhooks, tokens do bot e do admin, inbox WhatsApp.
- [ ] Parear o QR e apagar o `qr.png`.
- [ ] Cron do backup e um `--restore-test` de verdade.
- [ ] healthchecks.io, UptimeRobot, regra de `pending` no Chatwoot.

## O que só o Leonardo destrava

Lista fechada em `DECISOES-PENDENTES.md`:

1. Modelo de IA e `LLM_APPROVED_FOR_PRODUCTION=true`. Sem isso o agente não vai para `live`.
2. 30 conversas do FabChat (evals/replay) e os textos reais do `app/config/ebm.yaml`.
3. ID do Lorenzo no Chatwoot e o horário dele (`destino.user_id` e `users_map`).
4. `EVOLUTION_INSTANCE` e `GESTOR_WHATSAPP`. Sem isso o SLA só avisa por nota no Chatwoot.
5. URL do healthchecks.io.
6. Q2: Cloud API (tira o número do celular, irreversível) ou QR. O deploy escrito segue o QR.

## Resumo

Faltava documentação de subida, um resto de coluna Telegram e um furo no monitor. Os três foram commitados (`7604729`, `89afd0c`, `7725c12`, `ce38f4d`). O app está pronto para ir para uma VPS. Não está no ar: falta a VPS, o `.env`, o pareamento do QR e as seis decisões acima. Nada disso dá para inventar daqui.
