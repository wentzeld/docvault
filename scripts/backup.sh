#!/usr/bin/env bash
# DocVault backup script — suitable for cron
# Dumps the PostgreSQL database to a timestamped .sql.gz file.
#
# Usage:
#   bash scripts/backup.sh [--dir /path/to/backups] [--keep 30]
#
# Cron example (daily at 2am) — use the absolute path to your checkout:
#   0 2 * * * /path/to/docvault/scripts/backup.sh >> /var/log/docvault-backup.log 2>&1

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${DOCVAULT_BACKUP_DIR:-$HOME/backups/docvault}"
KEEP_COUNT=30

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --keep)
      KEEP_COUNT="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Load .env
if [ -f "$REPO_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -o allexport
  source "$REPO_DIR/.env"
  set +o allexport
fi

DB_URL="${DOCVAULT_DATABASE_URL:-}"
if [ -z "$DB_URL" ]; then
  echo "ERROR: DOCVAULT_DATABASE_URL not set" >&2
  exit 1
fi

# Create backup directory
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date '+%Y-%m-%d_%H-%M-%S')
FILENAME="docvault_${TIMESTAMP}.sql.gz"
FILEPATH="$BACKUP_DIR/$FILENAME"

echo "[$(date -Iseconds)] Starting backup to $FILEPATH ..."

# pg_dump piped through gzip
# Arguments passed as array — no shell interpolation of user data
pg_dump --no-password "$DB_URL" | gzip -c > "$FILEPATH"

SIZE_BYTES=$(stat -c%s "$FILEPATH")
SIZE_MB=$(echo "scale=2; $SIZE_BYTES / 1048576" | bc)

echo "[$(date -Iseconds)] Backup complete: $FILEPATH (${SIZE_MB} MB)"

# Rotate old backups — keep only the N most recent
BACKUP_FILES=()
while IFS= read -r -d $'\0' f; do
  BACKUP_FILES+=("$f")
done < <(find "$BACKUP_DIR" -name 'docvault_*.sql.gz' -print0 | sort -z -r)

TOTAL=${#BACKUP_FILES[@]}
if [ "$TOTAL" -gt "$KEEP_COUNT" ]; then
  TO_DELETE=("${BACKUP_FILES[@]:$KEEP_COUNT}")
  for f in "${TO_DELETE[@]}"; do
    rm -f "$f"
    echo "[$(date -Iseconds)] Removed old backup: $(basename "$f")"
  done
fi

echo "[$(date -Iseconds)] Backup rotation complete. Keeping ${KEEP_COUNT} most recent backups."
