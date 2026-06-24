#!/usr/bin/env bash
# DocVault Install Script — Ubuntu 24.04
# Run as the unprivileged application user that will own the service (NOT root).
# Idempotent: safe to re-run.
# Usage: bash scripts/install.sh
#
# Paths are derived from the checkout location and $HOME, and can be overridden:
#   DOCVAULT_VENV_DIR     — Python venv (default: $HOME/ml-env)
#   DOCVAULT_MODEL_CACHE  — embedding model cache (default: $HOME/.cache/docvault/models)
#   DOCVAULT_BACKUP_DIR   — backup target (default: $HOME/backups/docvault)

set -euo pipefail

# Resolve the repo root from this script's location, so the install works no
# matter where the repository was cloned.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${DOCVAULT_VENV_DIR:-$HOME/ml-env}"
MODEL_CACHE="${DOCVAULT_MODEL_CACHE:-$HOME/.cache/docvault/models}"
BACKUP_DIR="${DOCVAULT_BACKUP_DIR:-$HOME/backups/docvault}"
SERVICE_USER="$(id -un)"

echo "========================================"
echo "  DocVault Install — $(date)"
echo "========================================"

# ── Step 1: PostgreSQL 16 + pgvector ─────────────────────────────────────────
echo ""
echo "[1/11] Installing PostgreSQL 16 + pgvector..."
sudo apt-get update -qq
sudo apt-get install -y postgresql-16 postgresql-16-pgvector libpq-dev

# Ensure PostgreSQL is running
sudo systemctl enable --now postgresql

# Create database user and database (idempotent)
# If .env already has a real password, reuse it — don't rotate on every re-run.
if [ -f "$REPO_DIR/.env" ] && \
   grep -q "^DOCVAULT_DATABASE_URL=" "$REPO_DIR/.env" 2>/dev/null && \
   ! grep -q "^DOCVAULT_DATABASE_URL=postgresql://docvault:changeme" "$REPO_DIR/.env" 2>/dev/null; then
  DB_PASS=$(grep "^DOCVAULT_DATABASE_URL=" "$REPO_DIR/.env" | sed 's|.*://docvault:\([^@]*\)@.*|\1|')
  echo "  Re-using existing DB password from .env"
else
  DB_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
fi

# Create role (DO block is fine for role creation)
sudo -u postgres psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docvault') THEN
    CREATE ROLE docvault WITH LOGIN PASSWORD '$DB_PASS';
    RAISE NOTICE 'Created role docvault';
  ELSE
    ALTER ROLE docvault WITH PASSWORD '$DB_PASS';
    RAISE NOTICE 'Updated role docvault password';
  END IF;
END\$\$;
SQL

# CREATE DATABASE cannot run inside a DO block — use shell conditional
DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='docvault'" 2>/dev/null)
if [ "$DB_EXISTS" != "1" ]; then
  sudo -u postgres createdb -O docvault docvault
  echo "  Created database docvault."
else
  echo "  Database docvault already exists."
fi
# Write generated password into .env if it was just created
if grep -q "^DOCVAULT_DATABASE_URL=postgresql://docvault:changeme" "$REPO_DIR/.env" 2>/dev/null; then
  sed -i "s|postgresql://docvault:changeme|postgresql://docvault:$DB_PASS|g" "$REPO_DIR/.env"
  echo "  Generated and stored DB password."
fi

# Enable extensions
sudo -u postgres psql -d docvault -c "CREATE EXTENSION IF NOT EXISTS vector;"
sudo -u postgres psql -d docvault -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

echo "  PostgreSQL configured."

# ── Step 2: Node.js 22 ────────────────────────────────────────────────────────
echo ""
echo "[2/11] Verifying Node.js 22..."
if ! node --version 2>/dev/null | grep -q "^v22"; then
  echo "  Node.js 22 not found — installing..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  Node.js: $(node --version)"

# ── Step 3: Python environment ────────────────────────────────────────────────
echo ""
echo "[3/11] Setting up Python environment at $VENV_DIR..."
if [ ! -f "$VENV_DIR/bin/python" ]; then
  echo "  ~/ml-env not found — creating a CPU-only Python venv."
  echo "  (For GPU acceleration, pre-create ~/ml-env with PyTorch+CUDA before running this script.)"
  python3 -m venv "$VENV_DIR"
  "$VENV_DIR/bin/pip" install --quiet --upgrade pip
  # CPU-only PyTorch — smaller download, no CUDA deps
  "$VENV_DIR/bin/pip" install --quiet torch --index-url https://download.pytorch.org/whl/cpu
  echo "  Created CPU-only venv. Set DOCVAULT_EMBEDDING_DEVICE=cpu in .env (auto-detected at runtime)."
fi
echo "  Python: $($VENV_DIR/bin/python --version)"
echo "  PyTorch: $($VENV_DIR/bin/python -c 'import torch; print(torch.__version__)' 2>/dev/null || echo 'not found')"
CUDA_AVAIL=$($VENV_DIR/bin/python -c 'import torch; print(torch.cuda.is_available())' 2>/dev/null || echo 'unknown')
echo "  CUDA available: $CUDA_AVAIL"
if [ "$CUDA_AVAIL" = "False" ]; then
  echo "  NOTE: Running in CPU mode. Embedding will work but indexing will be slower."
  echo "        Semantic and hybrid search are fully supported."
fi

# ── Step 4: Node dependencies ────────────────────────────────────────────────
echo ""
echo "[4/11] Installing Node.js dependencies..."
cd "$REPO_DIR"
npm install

# ── Step 5: Python dependencies ──────────────────────────────────────────────
echo ""
echo "[5/11] Installing Python dependencies into venv..."
"$VENV_DIR/bin/pip" install --quiet \
  "sentence-transformers>=2.7.0" \
  "psycopg[binary]>=3.1.19" \
  "aiohttp>=3.9.5" \
  "python-dotenv>=1.0.0"
echo "  Python dependencies installed."

# ── Step 6: Download embedding model ─────────────────────────────────────────
echo ""
echo "[6/11] Downloading nomic-embed-text-v1.5 model..."
mkdir -p "$MODEL_CACHE"
"$VENV_DIR/bin/python" - <<PYEOF
import os, sys
sys.path.insert(0, '$REPO_DIR/worker')
model_path = '$MODEL_CACHE'
print(f'  Downloading to {model_path}...')
try:
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(
        'nomic-ai/nomic-embed-text-v1.5',
        trust_remote_code=True,
        cache_folder=model_path,
    )
    print(f'  Model ready.')
except Exception as e:
    print(f'  Warning: model download failed: {e}')
    print('  The worker will try again on startup.')
PYEOF

# ── Step 7: Build TypeScript ──────────────────────────────────────────────────
echo ""
echo "[7/11] Building TypeScript..."
cd "$REPO_DIR"
npm run build
echo "  TypeScript build complete."

# ── Step 8: Database migrations ──────────────────────────────────────────────
echo ""
echo "[8/11] Running database migrations..."

# Copy .env.example to .env if not present
if [ ! -f "$REPO_DIR/.env" ]; then
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  chmod 600 "$REPO_DIR/.env"
  echo "  Created .env from .env.example"
fi

# Auto-patch DB URL: if still has changeme, generate + apply a new password
# (Step 1 may have already done this if .env existed; if .env was just created, do it now)
if grep -q "^DOCVAULT_DATABASE_URL=postgresql://docvault:changeme" "$REPO_DIR/.env" 2>/dev/null; then
  DB_PASS_8=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
  sudo -u postgres psql -c "ALTER ROLE docvault WITH PASSWORD '$DB_PASS_8';" 2>/dev/null || true
  sed -i "s|postgresql://docvault:changeme@|postgresql://docvault:${DB_PASS_8}@|g" "$REPO_DIR/.env"
  echo "  Auto-generated and stored DB password."
fi

# Auto-generate secret key if not set
# shellcheck disable=SC1091
source "$REPO_DIR/.env" || true
if [ -z "${DOCVAULT_AUTH_SECRET_KEY:-}" ]; then
  SECRET=$(openssl rand -hex 32)
  sed -i "s/^DOCVAULT_AUTH_SECRET_KEY=$/DOCVAULT_AUTH_SECRET_KEY=$SECRET/" "$REPO_DIR/.env"
  echo "  Generated DOCVAULT_AUTH_SECRET_KEY."
fi

if grep -q "changeme" "$REPO_DIR/.env" 2>/dev/null; then
  echo "ERROR: .env still contains default credentials. Aborting." >&2
  exit 1
fi

# Apply migrations — raw SQL only (migrations written manually, no drizzle-kit journal)
# All migrations use IF NOT EXISTS / IF EXISTS — safe to re-run on upgrades.
DB_URL=$(grep "^DOCVAULT_DATABASE_URL=" "$REPO_DIR/.env" | cut -d'=' -f2-)
if [ -n "$DB_URL" ]; then
  for migration in "$REPO_DIR"/src/db/migrations/*.sql; do
    echo "  Applying $(basename "$migration")..."
    psql "$DB_URL" -f "$migration" \
      && echo "  $(basename "$migration") applied." \
      || echo "  Note: $(basename "$migration") ran (some statements may have been no-ops — normal on re-run)"
  done
else
  echo "ERROR: DOCVAULT_DATABASE_URL not set in .env" >&2
  exit 1
fi

# ── Step 9: Create admin user ─────────────────────────────────────────────────
echo ""
echo "[9/11] Setting up admin user..."
echo "  Create admin password for web UI login:"
node "$REPO_DIR/dist/api/cli/index.js" admin user set-password --username admin || true

echo ""
echo "  Creating admin API token..."
node "$REPO_DIR/dist/api/cli/index.js" admin token create \
  --name "admin" \
  --agent-id "admin" \
  --scopes "read,write,admin" || true


mkdir -p "$BACKUP_DIR"

# ── Step 10: Caddy setup ──────────────────────────────────────────────────────
echo ""
echo "[10/11] Setting up Caddy..."
if ! command -v caddy &>/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update -qq && sudo apt-get install -y caddy
fi

sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy || true

# Get Tailscale IP (no cert provisioning — using plain HTTP over WireGuard-encrypted Tailscale)
if command -v tailscale &>/dev/null; then
  TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "")

  if [ -n "$TAILSCALE_IP" ]; then
    sudo cp "$REPO_DIR/infra/Caddyfile" /etc/caddy/Caddyfile
    sudo sed -i "s/100\.x\.x\.x/$TAILSCALE_IP/g" /etc/caddy/Caddyfile
    sudo systemctl enable caddy
    sudo systemctl restart caddy
    echo "  Caddy configured for Tailscale IP: $TAILSCALE_IP (plain HTTP)"
  else
    echo "  WARNING: Tailscale IP not found. Edit /etc/caddy/Caddyfile manually."
  fi
else
  echo "  WARNING: tailscale not found. Configure Caddy manually."
fi

# ── Step 11: systemd services ─────────────────────────────────────────────────
echo ""
echo "[11/11] Enabling systemd services..."
# The unit files ship as templates with __DOCVAULT_*__ placeholders. Substitute
# the resolved user/paths for this host while copying them into place.
for unit in docvault-api.service docvault-worker.service; do
  sed \
    -e "s|__DOCVAULT_USER__|$SERVICE_USER|g" \
    -e "s|__DOCVAULT_DIR__|$REPO_DIR|g" \
    -e "s|__DOCVAULT_VENV__|$VENV_DIR|g" \
    -e "s|__DOCVAULT_CACHE__|$(dirname "$MODEL_CACHE")|g" \
    "$REPO_DIR/infra/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable docvault-api docvault-worker
sudo systemctl start docvault-api docvault-worker

echo ""
echo "========================================"
echo "  DocVault installation complete!"
echo "========================================"
echo ""
echo "  API:     http://$(tailscale ip -4 2>/dev/null || echo '<tailscale-ip>')"
echo "  Status:  systemctl status docvault-api docvault-worker"
echo "  Logs:    journalctl -u docvault-api -u docvault-worker -f"
echo ""
echo "  Next steps:"
echo "   1. Verify the API: curl http://<tailscale-ip>/health"
echo "   2. Open the web UI in your browser"
echo "   3. Log in with username 'admin' and the password you set"
echo ""
