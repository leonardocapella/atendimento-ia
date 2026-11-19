# Decisões que só o Leonardo fecha

- **D2.** Modelo de IA de produção e custo mensal. Até lá o app fica agnóstico (`LLM_BASE_URL` compatível com OpenAI) e recusa agente `live` sem `LLM_APPROVED_FOR_PRODUCTION=true`.
- **30 conversas do FabChat.** T6 e T7 usam `app/evals/ficticio/` (marcado). Trocar quando os exports chegarem. O Lorenzo marca o turno certo do handoff em cada uma.
- **Telegram do gestor.** Criar o bot no @BotFather e preencher `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`. Sem isso o alerta de SLA fica só na nota do Chatwoot.
- **healthchecks.io.** Criar um check grátis e colar a URL em `HEALTHCHECK_URL`. UptimeRobot no Chatwoot público. A regra de `pending` sem resposta está em `ops/chatwoot-pending.md` (fazer na mão no Chatwoot).
- **Open Q2.** Cloud API ou QR no número atual. Cloud API tira o número do WhatsApp do celular. Irreversível.
- **GHCR.** O CI publica a imagem só se o repositório for público (pacote grátis). Repo privado cobra. Confirmar antes do primeiro push em `main`.
