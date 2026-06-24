# Contributing to DocVault

Thanks for your interest in contributing! This guide covers local setup, tests,
code style, and the PR workflow.

## Prerequisites

- **Node.js 22+** (the project sets `"type": "module"` and targets Node >= 22)
- **PostgreSQL 16** with the **pgvector** and **pg_trgm** extensions
- **Python 3.12** (for the embedding worker)

## Local setup

```bash
# 1. Clone and enter the repo
git clone <your-fork-url> docvault
cd docvault

# 2. Configure environment
cp .env.example .env
chmod 600 .env
# Set DOCVAULT_AUTH_SECRET_KEY (openssl rand -hex 32) and DOCVAULT_DATABASE_URL.

# 3. Install Node dependencies and build
npm install
npm run build          # API (tsc -p tsconfig.api.json)
npm run build:ui       # React UI (vite build)

# 4. Set up the Python worker
python3.12 -m venv ~/ml-env
~/ml-env/bin/pip install --upgrade pip
~/ml-env/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
~/ml-env/bin/pip install -r worker/requirements.txt

# 5. Apply database migrations
npm run db:migrate
# (or run the full provisioning script on Ubuntu: bash scripts/install.sh)
```

You can also bring up the whole stack with Docker — see the
"Quick start with Docker" section of the README.

### Running the services

```bash
npm start                       # API (node dist/api/api/index.js)
~/ml-env/bin/python worker/main.py   # embedding worker
```

## Database migrations

DocVault uses **raw-SQL migrations** in `src/db/migrations/*.sql`. There is **no
drizzle migration journal** — migrations are plain `.sql` files applied in
filename order. Every statement must be idempotent (use `IF NOT EXISTS` /
`IF EXISTS`) so migrations are safe to re-run on upgrade.

When adding schema changes, create a new numbered file (e.g.
`0003_my_change.sql`) rather than editing existing migrations.

## Tests

```bash
npm test
```

## Code style

- **TypeScript strict mode.** Keep the typecheck clean:

  ```bash
  npm run lint        # tsc --noEmit -p tsconfig.api.json
  ```

- For the UI, also run `npx tsc --noEmit -p src/ui/tsconfig.json`.
- Match the existing formatting and import conventions (ESM `.js` import
  specifiers in compiled paths, named exports for route plugins, etc.).

## Branches & pull requests

- Branch off `main` using a descriptive prefix: `feat/...`, `fix/...`,
  `docs/...`, `chore/...`.
- Keep PRs focused and reasonably small.
- Write clear commit messages (Conventional Commits style is appreciated,
  e.g. `feat(ui): ...`, `fix(api): ...`).
- Ensure `npm run lint`, `npm test`, and `npm run build` all pass before
  opening a PR.
- Describe the change and how you tested it in the PR description.

## Reporting bugs & security issues

Open a GitHub issue for bugs and feature requests. For security
vulnerabilities, please follow the private disclosure process in
[SECURITY.md](./SECURITY.md) instead of filing a public issue.
