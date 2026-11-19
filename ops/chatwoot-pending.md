# Fallback com o brain fora do ar (T10)

Regra no Chatwoot, feita na mão (Configurações > Automação). Não depende do app.

- Evento: conversa criada ou mensagem criada.
- Condição: status `pending` e sem resposta de agente há mais de 15 min.
- Ação: mudar status para `open` e atribuir ao time Vendas.

Assim o Lorenzo vê a conversa mesmo se a API e o worker estiverem parados.
O UptimeRobot (grátis) aponta para `https://painel.../health` só por dentro da VPS, ou para a URL pública do Chatwoot. `/health` não é público (Caddy responde 404).
O worker pinga `HEALTHCHECK_URL` (healthchecks.io, grátis) a cada volta ociosa.
