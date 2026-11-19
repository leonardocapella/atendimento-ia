# Decisões que só o Leonardo fecha

- **D2.** Modelo de IA de produção e custo mensal. Até lá o app fica agnóstico (`LLM_BASE_URL` compatível com OpenAI) e recusa agente `live` sem `LLM_APPROVED_FOR_PRODUCTION=true`.
- **30 conversas do FabChat.** T6 e T7 usam `app/evals/ficticio/` (marcado). Trocar quando os exports chegarem. O Lorenzo marca o turno certo do handoff em cada uma. Os textos de `app/config/ebm.yaml` hoje são exemplo e saem do mesmo material.
- **ID do Lorenzo no Chatwoot** e o horário dele. `destino.user_id` no YAML e a linha em `users_map` têm que ser o usuário real. O seed demo usa o usuário 2 e não entra em produção (`SEED_DEMO` vazio).
- **WhatsApp do gestor.** Preencher `EVOLUTION_INSTANCE` e `GESTOR_WHATSAPP` (DDI, só o gestor). Sem isso o alerta de SLA fica só na nota do Chatwoot. Worker morto não manda WhatsApp: o healthchecks.io avisa por e-mail.
- **healthchecks.io.** Criar um check grátis e colar a URL em `HEALTHCHECK_URL`. UptimeRobot no Chatwoot público. A regra de `pending` sem resposta está em `ops/chatwoot-pending.md` (fazer na mão no Chatwoot).
- **Open Q2.** Cloud API ou QR no número atual. Cloud API tira o número do WhatsApp do celular. Irreversível. O deploy escrito segue o QR.

## Ajustes pedidos após a prévia com Gemini

Prévia em 19/11/2026 (`/workspace/previa/conversa.md`, gemini-2.5-flash). Cliente fictício. Nada foi para o WhatsApp. Leonardo aprovou. Não apagar esta seção.

No turno 4 a Carla perguntou o preço. A Malu transferiu (`pedido_cliente`) e ainda perguntou a cidade na mesma fala. `sinal_compra` ligou no turno 3 só com as medidas.

- Pedido de preço não é transbordo. A Malu diz que o preço depende das medidas e segue a qualificação.
- Nunca transferir e perguntar na mesma fala. Se falta campo, só pergunta.
- Nome válido do perfil do WhatsApp entra na conversa. Não perguntar o nome de novo.
- `sinal_compra` só com intenção clara de fechar, proposta ou orçamento. Medidas, prazo ou "quanto custa" não bastam.
- No máximo 3 frases. Se o corte tirar a pergunta, ela volta no lugar da última.
- Fallback grátis só quando o principal responde 429 (`LLM_FALLBACK_*`). 500 não troca de modelo.

## Controle da IA (teste ao vivo, 19/11)

Leonardo para a IA sozinho. Aprovado na implementação. Não apagar esta seção.

- `IA_PAUSAR_NO_TRANSBORDO=false` (padrão). Transbordo atribui ao Lorenzo, com nota e prioridade, sem a etiqueta `ia-pausada`. A Malu continua.
- Etiqueta `ia-pausada` numa conversa pausa. Removida, retoma.
- Botão no painel (`http://127.0.0.1:8081`) liga e desliga todas as conversas sem reiniciar. `IA_ATIVA=false` trava desligada.
- Fora do escopo (armário para carro) não transfere. A Malu explica o que a EBM faz e segue.
