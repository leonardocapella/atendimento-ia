# Deploy na VPS (pt-BR)

Sobe Chatwoot + app + Postgres + Redis + Caddy. WhatsApp do número atual entra pela Evolution, pareando por QR (`docker-compose.qr.yml`). Nada aqui foi testado com Docker nesta máquina: ela não tem Docker. Rode os comandos na VPS.

Caminho com Cloud API oficial existe no Chatwoot e tira o número do WhatsApp do celular. Irreversível. Enquanto a decisão Q2 não fecha, o passo a passo abaixo é o QR.

## O que a VPS precisa

- 4 a 6 GB de RAM. Com QR, conte +1 GB. Disco 40 GB sobra para imagem, Postgres e mídia.
- Docker Engine + Compose v2. Portas 22, 80 e 443 liberadas. Postgres, Redis, app e Evolution não publicam porta.
- DNS de `chat.seudominio` e `painel.seudominio` apontando para a VPS. Só ligue o DNS depois da 1ª configuração (passo 4).
- Um domínio de verdade. O Caddy pede certificado Let's Encrypt sozinho.

## 1. Variáveis

```bash
cp .env.example .env
chmod 600 .env
```

Senha que entra em URL tem que ser hex. Base64 quebra a conexão.

| Variável | Como gerar / o que é |
|---|---|
| `DOMAIN` | domínio raiz, ex. `ebm.com.br` |
| `CHATWOOT_HOST` | `chat.ebm.com.br` |
| `PAINEL_HOST` | `painel.ebm.com.br` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `REDIS_PASSWORD` | `openssl rand -hex 24` |
| `BRAIN_DB_PASSWORD` | `openssl rand -hex 24` — usuário `brain`, sem acesso ao banco do Chatwoot |
| `CHATWOOT_SECRET_KEY_BASE` | `openssl rand -hex 64` |
| `MASTER_KEY` | `openssl rand -hex 32` — criptografia do app. Cópia offline, fora da VPS. Perdeu, não descriptografa. |
| `WEBHOOK_SECRET` | `openssl rand -hex 24` — vai no path do webhook |
| `CHATWOOT_BOT_TOKEN` | vazio até criar o Agent Bot |
| `CHATWOOT_ADMIN_TOKEN` | vazio até criar o admin. Atribui, label, nota privada |
| `LLM_BASE_URL` | API compatível com OpenAI (`/v1`). Sem barra no fim não importa; o cliente normaliza |
| `LLM_MODEL` | nome do modelo nesse provedor |
| `LLM_API_KEY` | chave. Vazio se o provedor local não pede |
| `LLM_APPROVED_FOR_PRODUCTION` | `false` até o Leonardo escolher o modelo (D2). Com `false`, agente `status: live` no YAML impede o worker de subir |
| `LLM_FALLBACK_BASE_URL` | vazio = sem fallback. API compatível com OpenAI, plano grátis |
| `LLM_FALLBACK_MODEL` | modelo desse provedor. Só entra quando o principal responde 429 |
| `LLM_FALLBACK_API_KEY` | chave do fallback. Vazio se o provedor não pede |
| `IA_PAUSAR_NO_TRANSBORDO` | `false` (padrão). Transbordo atribui, anota e marca prioridade, e a Malu continua. `true` pausa e põe a etiqueta `ia-pausada` |
| `IA_ATIVA` | `false` trava a IA desligada em todas as conversas. `true` ou vazio: o painel liga e desliga sem reiniciar |
| `SEED_DEMO` | vazio em produção. `true` só cria tenant, Lorenzo fictício (usuário 2) e 2 produtos de exemplo |
| `HEALTHCHECK_URL` | URL do check grátis no healthchecks.io. Vazio = worker não pinga |
| `SMTP_*` | opcional. E-mail do Chatwoot |
| `EVOLUTION_API_KEY` | `openssl rand -hex 24`. Obrigatória no QR |
| `EVOLUTION_DB_PASSWORD` | `openssl rand -hex 24`. Obrigatória **antes** da 1ª subida do volume do Postgres. O `init.sh` só roda em volume vazio |
| `EVOLUTION_URL` | `http://evolution:8080` (rede interna) |
| `EVOLUTION_INSTANCE` | nome curto da instância, ex. `ebm`. Letras, números, `_` e `-`, até 64 |
| `GESTOR_WHATSAPP` | WhatsApp do gestor com DDI, ex. `5561999999999`. Vazio = alerta de SLA fica só na nota do Chatwoot. Nunca um número de cliente |

Guarde `.env` e `MASTER_KEY` fora da VPS. O `.env` não vai para o git.

## 2. Subir sem abrir o DNS

```bash
docker compose -f docker-compose.yml -f docker-compose.qr.yml up -d --build
docker compose logs -f chatwoot
```

Espere `Listening on http://0.0.0.0:3000`. O serviço `api` fica `healthy`. A 1ª subida puxa a imagem do Chatwoot (grande).

`SEED_DEMO` vazio: o `api` só aplica as migrations (`app/migrations/*.sql`).

## 3. Primeira conta do Chatwoot

A porta 3000 escuta só em `127.0.0.1` na VPS. Do seu computador:

```bash
ssh -L 3000:127.0.0.1:3000 usuario@vps
```

Abra http://localhost:3000 e crie o admin. Pelo domínio público, `/installation` e `/super_admin` respondem 404 (Caddy).

Anote o ID da conta (instalação nova = 1) e o ID do usuário do Lorenzo. O YAML de exemplo usa conta 1 e `destino.user_id: 2`. Se os IDs forem outros, ajuste `app/config/ebm.yaml` e suba de novo o `api` e o `worker` (passo 6).

## 4. DNS e TLS

Aponte `chat.` e `painel.` para a VPS. O Caddy emite o certificado. Firewall: 22, 80, 443. Nada mais.

- Chatwoot: `https://chat.seudominio`
- Painel: `https://painel.seudominio` — login com o access token do Chatwoot (Perfil > Token de acesso). Admin e gestor veem a config (só leitura) e o playground. Atendente não.
- Interruptor da IA, só nesta máquina: `http://127.0.0.1:8081` (túnel SSH na VPS). Admin e gestor ligam e desligam sem reiniciar. O worker lê o mesmo arquivo. `IA_ATIVA=false` trava desligada e o botão recusa.

`/health` e `/hooks/*` não são públicos. O Caddy responde 404.

## 5. Ligar o Chatwoot no app

Dois webhooks, os dois com a mesma URL interna. Troque `<WEBHOOK_SECRET>` pelo valor do `.env`.

`http://api:8080/hooks/chatwoot/<WEBHOOK_SECRET>`

- Agent Bot: Configurações > Bots. Copie o token do bot para `CHATWOOT_BOT_TOKEN`.
- Webhook da conta: Configurações > Integrações > Webhooks. Eventos `message_created`, `message_updated`, `conversation_updated`.

Token de admin (Perfil > Token de acesso) vai em `CHATWOOT_ADMIN_TOKEN`.

Recrie api e worker para lerem o `.env` novo:

```bash
docker compose -f docker-compose.yml -f docker-compose.qr.yml up -d
```

## 6. Textos, Lorenzo e papéis

`app/config/ebm.yaml` versionado é exemplo (nome Malu, produtos fictícios). Troque pelos textos da EBM, confira `chatwoot_account_id` e `destino.user_id` (ID do Lorenzo) e suba a imagem de novo:

```bash
docker compose -f docker-compose.yml -f docker-compose.qr.yml up -d --build api worker
```

Config inválida derruba a subida. O log aponta o campo.

Mapa de papéis no banco `brain` (o SLA menciona gestor/admin; o horário do Lorenzo atrasa o relógio para a abertura do expediente):

```bash
docker compose exec -T postgres psql -U postgres -d brain
```

```sql
INSERT INTO users_map (tenant_id, chatwoot_user_id, role, horario)
SELECT id, 2, 'atendente',
  '{"seg":[["09:00","18:00"]],"ter":[["09:00","18:00"]],"qua":[["09:00","18:00"]],"qui":[["09:00","18:00"]],"sex":[["09:00","18:00"]]}'::jsonb
FROM tenants WHERE chatwoot_account_id = 1
ON CONFLICT DO NOTHING;
```

Troque `2` pelo ID real. Outra linha com `role = 'gestor'` para quem deve ser mencionado no estouro de SLA.

Não ligue `status: live` no YAML enquanto `LLM_APPROVED_FOR_PRODUCTION` não for `true`.

## Quem para a IA

Com `IA_PAUSAR_NO_TRANSBORDO=false` (padrão), lead quente e pedido de humano atribuem a conversa ao Lorenzo, com nota privada e prioridade. A etiqueta `ia-pausada` não entra. A Malu continua respondendo.

Três cortes, todos manuais:

1. **Uma conversa.** No Chatwoot, adicione a etiqueta `ia-pausada`. Tirar a etiqueta retoma. Fala do Lorenzo não pausa.
2. **Todas.** No painel (`http://127.0.0.1:8081`), o botão grava o estado num volume compartilhado por `api` e `worker`. Vale na hora, sem reiniciar.
3. **Trava.** `IA_ATIVA=false` no `.env` e recrie os containers. O botão do painel não consegue ligar por cima.

Pedido fora do que a EBM faz (ex.: armário para carro) não transfere. A Malu explica o que a empresa faz e segue.

## 7. WhatsApp por QR (Evolution)

O compose de QR não publica porta. A instância se cria de dentro da rede, pelo container `api` (ele já tem a chave e alcança `evolution`).

Nome da instância = `EVOLUTION_INSTANCE` do `.env`.

```bash
docker compose exec -T api node --input-type=module -e '
const base = process.env.EVOLUTION_URL.replace(/\/$/, "");
const name = process.env.EVOLUTION_INSTANCE;
const h = { apikey: process.env.EVOLUTION_API_KEY, "content-type": "application/json" };
let r = await fetch(base + "/instance/create", { method: "POST", headers: h,
  body: JSON.stringify({ instanceName: name, integration: "WHATSAPP-BAILEYS", qrcode: true }) });
console.log("create", r.status, (await r.text()).slice(0, 400));
r = await fetch(base + "/instance/connect/" + name, { headers: h });
const j = await r.json();
console.log("pairing", j.pairingCode || "");
if (j.base64) {
  const b64 = String(j.base64).replace(/^data:image\/\w+;base64,/, "");
  const fs = await import("node:fs");
  fs.writeFileSync("/tmp/qr.png", Buffer.from(b64, "base64"));
  console.log("qr em /tmp/qr.png dentro do container api");
}
'
docker compose cp api:/tmp/qr.png ./qr.png
```

No celular do número da EBM: WhatsApp > Aparelhos conectados > Conectar > escanear `qr.png`. Apague `qr.png` depois. Estado:

```bash
docker compose exec -T api node --input-type=module -e '
const base = process.env.EVOLUTION_URL.replace(/\/$/, "");
const r = await fetch(base + "/instance/connectionState/" + process.env.EVOLUTION_INSTANCE,
  { headers: { apikey: process.env.EVOLUTION_API_KEY } });
console.log(await r.text());
'
```

`open` = pareado. No Chatwoot, a inbox WhatsApp aponta para essa instância (Evolution com `CHATWOOT_ENABLED=true`).

Risco: QR (Baileys) viola os termos do WhatsApp e pode banir o número. Sem disparo em massa. Número que dá para perder.

Alerta do gestor: a mesma instância manda WhatsApp para `GESTOR_WHATSAPP` quando o SLA estoura ou o envio ao Chatwoot falha. Sem instância ou sem número, não sai nada além da nota privada.

## 8. Backup

Cron na VPS, todo dia, com o diretório fora do disco único se puder (outra máquina, ou cópia puxada por SSH):

```bash
0 4 * * * cd /caminho/atendimento-ia && ./ops/backup.sh /var/backups/atendimento-ia
```

O script faz `pg_dumpall` e grava `AAAA-MM-DD.sql.gz`.

Mídia do Chatwoot (fotos, áudio), no mesmo cron:

```bash
docker run --rm -v atendimento-ia_chatwoot-storage:/s -v /var/backups/atendimento-ia:/b alpine \
  tar czf /b/storage-$(date +%F).tgz -C /s .
```

Teste de restore, uma vez, antes de confiar:

```bash
./ops/backup.sh --restore-test /var/backups/atendimento-ia/AAAA-MM-DD.sql.gz
```

Sobe um Postgres descartável, aplica o dump e confere se a tabela `tenants` existe. Não mexe no volume de produção.

O `infra/postgres-init.sh` só roda com volume vazio. Restore de desastre: volume novo, `pg_dumpall` recria bancos e usuários, e a `MASTER_KEY` antiga tem que ser a mesma do `.env`.

Logs de container: 10 MB × 3 arquivos por serviço.

## 9. Monitor

Três camadas, todas grátis. Nenhuma substitui a outra.

1. **Worker vivo.** Crie um check no healthchecks.io (período 5 min, graça 5 min) e cole a URL em `HEALTHCHECK_URL`. O worker pinga no máximo 1 vez por minuto, com fila cheia ou vazia. Se o processo morre, o check avisa por e-mail. Esse ping não passa pela Evolution: worker morto não manda WhatsApp.
2. **Site no ar.** UptimeRobot na URL pública do Chatwoot (`https://chat.seudominio`). `/health` do app não é público.
3. **App inteiro caído.** Regra de automação no Chatwoot, na mão, como em `ops/chatwoot-pending.md`: conversa `pending` sem resposta de agente há 15 min vira `open` e cai no time Vendas. O Lorenzo vê mesmo com api e worker parados.

## 10. Imagem pronta (opcional)

No push da `main`, o GitHub Actions publica `ghcr.io/<dono>/<repo>:<sha>`. A VPS pequena pode puxar essa imagem em vez de compilar. Troque `image:` do `api` e do `worker` no compose pelo endereço publicado e suba sem `--build`. O restante (Chatwoot, Postgres, Caddy, Evolution) continua sendo puxado do Docker Hub na hora do `up`.
