# syntax=docker/dockerfile:1

# ---- Stage 1: build ----------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Install root dependencies first (better layer caching).
COPY package.json package-lock.json* ./
RUN npm ci

# Copy the rest of the source and build the API (tsc) -> dist/api
COPY . .
RUN npm run build

# Build the React UI (vite) -> dist/ui. The UI is its own package with its own lockfile.
RUN npm ci --prefix src/ui || npm install --prefix src/ui
RUN npm run build:ui

# Produce a production-only node_modules to copy into the runtime image.
RUN npm prune --omit=dev

# ---- Stage 2: runtime --------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production

# postgresql-client: applies SQL migrations at startup. curl: healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production dependencies and build artifacts.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Raw-SQL migrations + runtime config + startup script.
COPY --from=build /app/src/db/migrations ./src/db/migrations
COPY --from=build /app/config ./config
COPY --from=build /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod +x ./scripts/docker-entrypoint.sh \
    && chown -R node:node /app

EXPOSE 3000

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/health || exit 1

# Entrypoint applies migrations then exec's the node start command.
CMD ["./scripts/docker-entrypoint.sh"]
