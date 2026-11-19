#!/usr/bin/env bash
# Sobe o ambiente de TESTE no GitHub Codespace: Chatwoot + Evolution (QR) + app com Gemini.
# Idempotente: pode rodar de novo. Uso: bash scripts/codespace-up.sh
#   --retomar  só religa os containers se o .env já existir (usado no postStartCommand)
# Segredos: GEMINI_API_KEY vem do secret do Codespaces. O .env e as credenciais não vão para o git.
# Use só um número de TESTE no QR. Nunca o número da EBM.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.qr.yml -f docker-compose.codespace.yml)
SERVICOS=(postgres redis chatwoot-migrate chatwoot sidekiq api worker evolution)   # sem Caddy no Codespace
CRED=.codespace-credenciais.txt
INSTANCIA=${EVOLUTION_INSTANCE:-teste}
INBOX="WhatsApp Teste"

# Sessão por `gh codespace ssh` não herda os secrets: lê do arquivo do Codespaces (valores em base64)
SEGREDOS=/workspaces/.codespaces/shared/.env-secrets
for k in GEMINI_API_KEY CODESPACE_NAME GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN; do
  if [ -z "${!k:-}" ] && [ -r "$SEGREDOS" ]; then
    v=$(grep "^$k=" "$SEGREDOS" | head -1 | cut -d= -f2- | base64 -d 2>/dev/null || true)
    [ -n "$v" ] && export "$k=$v"
  fi
done

log() { printf '\n==> %s\n' "$*"; }
espera_docker() { for _ in $(seq 60); do docker info >/dev/null 2>&1 && return; sleep 2; done; echo "Docker não respondeu" >&2; exit 1; }

if [ "${1:-}" = "--retomar" ]; then
  [ -f .env ] || exit 0
  espera_docker; "${COMPOSE[@]}" up -d "${SERVICOS[@]}"; exit 0
fi

[ -n "${GEMINI_API_KEY:-}" ] || { echo "Falta o secret GEMINI_API_KEY do Codespaces (github.com/settings/codespaces)." >&2; exit 1; }
[ -n "${CODESPACE_NAME:-}" ] || { echo "Rode dentro de um GitHub Codespace." >&2; exit 1; }
espera_docker

url_porta() { echo "https://${CODESPACE_NAME}-$1.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"; }
CHATWOOT_HOST="${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"

# grava/atualiza CHAVE=valor no .env sem passar o valor pela linha de comando de outro processo
setenv() { K="$1" V="$2" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]; f=0}
  $0 ~ "^"k"=" {print k"="v; f=1; next} {print} END{if(!f) print k"="v}' .env > .env.tmp && mv .env.tmp .env && chmod 600 .env; }
getenv() { awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,""); sub(/[ \t]+#.*$/,""); print; exit}' .env; }
hex() { openssl rand -hex "$1"; }

log "1/6 .env"
if [ ! -f .env ]; then
  cp .env.example .env; chmod 600 .env
  for k in POSTGRES_PASSWORD REDIS_PASSWORD BRAIN_DB_PASSWORD WEBHOOK_SECRET EVOLUTION_API_KEY EVOLUTION_DB_PASSWORD; do setenv "$k" "$(hex 24)"; done
  setenv CHATWOOT_SECRET_KEY_BASE "$(hex 64)"
  setenv MASTER_KEY "$(hex 32)"
  echo "   .env criado com segredos aleatórios"
fi
setenv DOMAIN app.github.dev
setenv CHATWOOT_HOST "$CHATWOOT_HOST"
setenv PAINEL_HOST "${CODESPACE_NAME}-8081.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
setenv LLM_BASE_URL https://generativelanguage.googleapis.com/v1beta/openai
setenv LLM_MODEL gemini-2.5-flash
setenv LLM_API_KEY "$GEMINI_API_KEY"
setenv LLM_APPROVED_FOR_PRODUCTION false
setenv SEED_DEMO true
setenv EVOLUTION_URL http://evolution:8080
setenv EVOLUTION_INSTANCE "$INSTANCIA"

if [ ! -f "$CRED" ]; then
  umask 077
  cat > "$CRED" <<CRED
# Ambiente de TESTE no Codespace. Não commitar.
CHATWOOT_ADMIN_EMAIL=admin.teste@example.com
CHATWOOT_ADMIN_SENHA=Ebm!$(hex 12)Z9
LORENZO_EMAIL=lorenzo.teste@example.com
LORENZO_SENHA=Ebm!$(hex 12)Z9
CRED
  umask 022
fi
chmod 600 "$CRED"
cred() { awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,""); print; exit}' "$CRED"; }

log "2/6 Subindo containers (a 1ª vez baixa a imagem do Chatwoot e demora alguns minutos)"
"${COMPOSE[@]}" up -d --build "${SERVICOS[@]}"

log "3/6 Esperando o Chatwoot responder"
for i in $(seq 120); do
  curl -fs -o /dev/null http://127.0.0.1:3000/api && break
  [ "$i" = 120 ] && { echo "Chatwoot não subiu em 10 min. Veja: docker compose logs chatwoot" >&2; exit 1; }
  sleep 5
done

log "4/6 Conta, admin de teste, Lorenzo de teste, Agent Bot e webhook no Chatwoot"
HOOK="http://api:8080/hooks/chatwoot/$(getenv WEBHOOK_SECRET)"
cat > /tmp/cw-bootstrap.rb <<'RUBY'
account = Account.order(:id).first || Account.create!(name: 'EBM (teste)', locale: 'pt_BR')
def usuario(account, nome, email, senha, papel)
  u = User.find_by(email: email)
  unless u
    u = User.new(name: nome, email: email, password: senha, password_confirmation: senha)
    u.skip_confirmation!
    u.save!
  end
  AccountUser.find_or_create_by!(account_id: account.id, user_id: u.id) { |au| au.role = papel }
  u
end
admin = usuario(account, 'Admin Teste', ENV.fetch('CS_ADMIN_EMAIL'), ENV.fetch('CS_ADMIN_SENHA'), :administrator)
lorenzo = usuario(account, 'Lorenzo (teste)', ENV.fetch('CS_LORENZO_EMAIL'), ENV.fetch('CS_LORENZO_SENHA'), :agent)
hook = ENV.fetch('CS_HOOK')
bot = AgentBot.find_by(name: 'Malu (IA)', account_id: account.id) ||
      AgentBot.create!(name: 'Malu (IA)', account_id: account.id, outgoing_url: hook)
bot.update!(outgoing_url: hook)
unless Webhook.exists?(account_id: account.id, url: hook)
  Webhook.create!(account_id: account.id, url: hook, subscriptions: %w[message_created message_updated conversation_updated])
end
inbox = Inbox.find_by(account_id: account.id, name: ENV.fetch('CS_INBOX'))
if inbox && !AgentBotInbox.exists?(inbox_id: inbox.id)
  AgentBotInbox.create!(inbox_id: inbox.id, agent_bot_id: bot.id, account_id: account.id)
end
if inbox
  InboxMember.find_or_create_by!(inbox_id: inbox.id, user_id: admin.id)
  InboxMember.find_or_create_by!(inbox_id: inbox.id, user_id: lorenzo.id)
end
begin
  ::Redis::Alfred.delete(::Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING)
rescue StandardError
end
puts "ACCOUNT_ID=#{account.id}"
puts "ADMIN_ID=#{admin.id}"
puts "LORENZO_ID=#{lorenzo.id}"
puts "INBOX_ID=#{inbox&.id}"
puts "CHATWOOT_ADMIN_TOKEN=#{admin.access_token.token}"
puts "CHATWOOT_BOT_TOKEN=#{bot.access_token.token}"
RUBY
rails_bootstrap() {
  "${COMPOSE[@]}" cp /tmp/cw-bootstrap.rb chatwoot:/tmp/cw-bootstrap.rb
  "${COMPOSE[@]}" exec -T \
    -e CS_ADMIN_EMAIL="$(cred CHATWOOT_ADMIN_EMAIL)" -e CS_ADMIN_SENHA="$(cred CHATWOOT_ADMIN_SENHA)" \
    -e CS_LORENZO_EMAIL="$(cred LORENZO_EMAIL)" -e CS_LORENZO_SENHA="$(cred LORENZO_SENHA)" \
    -e CS_HOOK="$HOOK" -e CS_INBOX="$INBOX" \
    chatwoot bundle exec rails runner /tmp/cw-bootstrap.rb 2>/dev/null | grep -E '^[A-Z_]+=' > /tmp/cw-out.txt
}
rails_bootstrap
out() { awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,""); print; exit}' /tmp/cw-out.txt; }
ADMIN_TOKEN=$(out CHATWOOT_ADMIN_TOKEN); BOT_TOKEN=$(out CHATWOOT_BOT_TOKEN); ACCOUNT_ID=$(out ACCOUNT_ID)
[ -n "$ADMIN_TOKEN" ] && [ -n "$BOT_TOKEN" ] || { echo "Falhou criar admin/bot no Chatwoot" >&2; exit 1; }
setenv CHATWOOT_ADMIN_TOKEN "$ADMIN_TOKEN"; setenv CHATWOOT_BOT_TOKEN "$BOT_TOKEN"
if [ "$ACCOUNT_ID" != 1 ] || [ "$(out ADMIN_ID)" != 1 ] || [ "$(out LORENZO_ID)" != 2 ]; then
  echo "   AVISO: IDs diferentes do YAML/seed (conta $ACCOUNT_ID, admin $(out ADMIN_ID), Lorenzo $(out LORENZO_ID)). Ajuste app/config/ebm.yaml."
fi
"${COMPOSE[@]}" up -d api worker   # relê os tokens

log "5/6 Instância WhatsApp na Evolution e inbox no Chatwoot"
EVO=http://127.0.0.1:8080; EVK=$(getenv EVOLUTION_API_KEY)
for i in $(seq 60); do curl -fs -o /dev/null "$EVO/" && break; [ "$i" = 60 ] && { echo "Evolution não subiu" >&2; exit 1; }; sleep 3; done
if ! curl -fs -H "apikey: $EVK" "$EVO/instance/fetchInstances?instanceName=$INSTANCIA" | grep -q "\"$INSTANCIA\""; then
  curl -fsS -X POST "$EVO/instance/create" -H "apikey: $EVK" -H 'content-type: application/json' \
    -d "{\"instanceName\":\"$INSTANCIA\",\"integration\":\"WHATSAPP-BAILEYS\",\"qrcode\":true}" -o /dev/null
  echo "   instância '$INSTANCIA' criada"
fi
curl -fsS -X POST "$EVO/chatwoot/set/$INSTANCIA" -H "apikey: $EVK" -H 'content-type: application/json' -d "{
  \"enabled\": true, \"accountId\": \"$ACCOUNT_ID\", \"token\": \"$ADMIN_TOKEN\", \"url\": \"http://chatwoot:3000\",
  \"signMsg\": false, \"reopenConversation\": true, \"conversationPending\": false, \"nameInbox\": \"$INBOX\",
  \"mergeBrazilContacts\": true, \"importContacts\": false, \"importMessages\": false, \"daysLimitImportMessages\": 0,
  \"autoCreate\": true }" -o /dev/null
echo "   integração Evolution -> Chatwoot ligada (inbox '$INBOX')"
sleep 5
rails_bootstrap   # agora a inbox existe: liga o Agent Bot nela e põe admin e Lorenzo como membros
[ -n "$(out INBOX_ID)" ] && echo "   Agent Bot ligado na inbox $(out INBOX_ID)" || echo "   AVISO: inbox '$INBOX' ainda não apareceu; rode o script de novo"

log "6/6 QR code"
STATE=$(curl -fsS -H "apikey: $EVK" "$EVO/instance/connectionState/$INSTANCIA" || true)
if echo "$STATE" | grep -q '"open"'; then
  echo "   WhatsApp já pareado."
else
  curl -fsS -H "apikey: $EVK" "$EVO/instance/connect/$INSTANCIA" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.base64){require("fs").writeFileSync("qr.png",Buffer.from(String(j.base64).replace(/^data:image\/\w+;base64,/,""),"base64"));console.log("   qr.png salvo (vale ~40 s; o /manager mostra sempre o atual)")}else console.log("   sem QR agora:",s.slice(0,200))})'
fi
grep -q '^EVOLUTION_API_KEY=' "$CRED" || echo "EVOLUTION_API_KEY=$EVK" >> "$CRED"
chmod 600 "$CRED"; [ -f qr.png ] && chmod 600 qr.png

cat <<FIM

Pronto. Use só um número de TESTE.
  Chatwoot:  $(url_porta 3000)   (login no arquivo $CRED)
  QR:        $(url_porta 8080)/manager   (Server URL: $(url_porta 8080), API Key: EVOLUTION_API_KEY em $CRED)
             WhatsApp > Aparelhos conectados > Conectar aparelho
  Painel:    $(url_porta 8081)
Containers: ${COMPOSE[*]} ps
FIM
