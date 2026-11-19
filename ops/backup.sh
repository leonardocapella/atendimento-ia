#!/bin/sh
# Backup do Postgres (T10). Roda NA VPS, com Docker já instalado lá. Este computador de dev não tem Docker.
# Uso: ./ops/backup.sh [dir]
# Restore de teste: ./ops/backup.sh --restore-test backups/AAAA-MM-DD.sql.gz
set -eu
dir="${1:-backups}"
if [ "${1:-}" = "--restore-test" ]; then
  dump="${2:?passe o arquivo .sql.gz}"
  # banco vazio e descartável: confere que o dump abre e tem as tabelas do brain
  cid=$(docker run -d --rm -e POSTGRES_PASSWORD=restoretest -e POSTGRES_DB=brain postgres:16)
  trap 'docker rm -f "$cid" >/dev/null' EXIT
  i=0
  until docker exec "$cid" pg_isready -U postgres >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 30 ] || exit 1; sleep 1; done
  gzip -dc "$dump" | docker exec -i "$cid" psql -U postgres -d brain -v ON_ERROR_STOP=1 >/dev/null
  docker exec "$cid" psql -U postgres -d brain -tAc "SELECT to_regclass('public.tenants')" | grep -q tenants
  echo "restore ok: $dump"
  exit 0
fi
mkdir -p "$dir"
out="$dir/$(date +%F).sql.gz"
docker compose exec -T postgres pg_dumpall -U postgres | gzip > "$out"
echo "$out"
