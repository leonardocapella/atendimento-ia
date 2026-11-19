# Decisões que só o Leonardo fecha

- **D2.** Modelo de IA de produção e custo mensal. Até lá o app fica agnóstico (`LLM_BASE_URL` compatível com OpenAI) e recusa agente `live` sem `LLM_APPROVED_FOR_PRODUCTION=true`.
- **30 conversas do FabChat.** T6 e T7 usam `app/evals/ficticio/` (marcado). Trocar quando os exports chegarem. O Lorenzo marca o turno certo do handoff em cada uma.
- **WhatsApp do gestor.** Preencher `EVOLUTION_INSTANCE` e `GESTOR_WHATSAPP` (DDI, só o gestor). Sem isso o alerta de SLA fica só na nota do Chatwoot. Worker morto não manda WhatsApp: o healthchecks.io avisa por e-mail.
- **healthchecks.io.** Criar um check grátis e colar a URL em `HEALTHCHECK_URL`. UptimeRobot no Chatwoot público. A regra de `pending` sem resposta está em `ops/chatwoot-pending.md` (fazer na mão no Chatwoot).
- **Open Q2.** Cloud API ou QR no número atual. Cloud API tira o número do WhatsApp do celular. Irreversível.
- **GHCR.** Decidido: repositório público, a imagem pode ir para o GHCR.

## Decididas pelo Leonardo (19/11/2026)

- **Repositório público.** Pode publicar a imagem no GHCR (grátis).
- **Sem Telegram.** O alerta do gestor vai só pelo WhatsApp (mesma instância Evolution/QR). Remover a dependência de Telegram do T9.
