#!/bin/sh
# DocVault API container entrypoint.
# Ensures required Postgres extensions exist, applies raw-SQL migrations in
# filename order, then starts the API.
#
# Migrations are plain .sql files in src/db/migrations/ (no drizzle journal).
# Every migration is written with IF NOT EXISTS / IF EXISTS, so re-running is safe.
set -e

if [ -z "${DOCVAULT_DATABASE_URL:-}" ]; then
  echo "ERROR: DOCVAULT_DATABASE_URL is not set." >&2
  exit 1
fi

MIGRATIONS_DIR="${DOCVAULT_MIGRATIONS_DIR:-/app/src/db/migrations}"

echo "[entrypoint] Ensuring required extensions (vector, pg_trgm)..."
psql "$DOCVAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql "$DOCVAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

echo "[entrypoint] Applying migrations from $MIGRATIONS_DIR..."
for migration in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$migration" ] || continue
  echo "[entrypoint]   -> $(basename "$migration")"
  psql "$DOCVAULT_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done

echo "[entrypoint] Migrations complete. Starting API..."
exec node --enable-source-maps dist/api/api/index.js
