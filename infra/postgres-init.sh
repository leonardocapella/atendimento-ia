#!/bin/sh
# Roda só na 1ª subida do volume. Cria um usuário por consumidor: o app (brain) e a Evolution
# não enxergam o banco do Chatwoot. Senhas devem ser hex (sem aspas), validado abaixo.
set -eu

hex() { case "$1" in *[!0-9a-fA-F]*|'') echo "senha $2 deve ser hex não vazio (openssl rand -hex 24)" >&2; exit 1;; esac; }
hex "$BRAIN_DB_PASSWORD" BRAIN_DB_PASSWORD

psql -v ON_ERROR_STOP=1 -U postgres -d chatwoot <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE CONNECT ON DATABASE chatwoot FROM PUBLIC;
CREATE ROLE brain LOGIN PASSWORD '$BRAIN_DB_PASSWORD';
CREATE DATABASE brain OWNER brain;
REVOKE CONNECT ON DATABASE brain FROM PUBLIC;
GRANT CONNECT ON DATABASE brain TO brain;
SQL
psql -v ON_ERROR_STOP=1 -U postgres -d brain -c 'CREATE EXTENSION IF NOT EXISTS vector;'

if [ -n "${EVOLUTION_DB_PASSWORD:-}" ]; then
  hex "$EVOLUTION_DB_PASSWORD" EVOLUTION_DB_PASSWORD
  psql -v ON_ERROR_STOP=1 -U postgres -d chatwoot <<SQL
CREATE ROLE evolution LOGIN PASSWORD '$EVOLUTION_DB_PASSWORD';
CREATE DATABASE evolution OWNER evolution;
REVOKE CONNECT ON DATABASE evolution FROM PUBLIC;
GRANT CONNECT ON DATABASE evolution TO evolution;
SQL
fi
