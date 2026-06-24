import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present (before reading config, so env vars override YAML)
// In source: src/config.ts → __dirname = src/ → '../.env' = repo root ✓
// In compiled: dist/api/config.js → __dirname = dist/api/ → '../../.env' = repo root ✓
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Expand a leading "~" to the user's home directory so config/env paths stay
// portable across machines and users.
export function expandHome(p: string): string {
  if (p === '~') return process.env.HOME ?? p;
  if (p.startsWith('~/')) return path.join(process.env.HOME ?? '.', p.slice(2));
  return p;
}

interface AppConfig {
  server: {
    host: string;
    port: number;
    log_level: string;
    body_limit: number;
  };
  database: {
    url: string;
    pool_min: number;
    pool_max: number;
    pool_idle_timeout_ms: number;
  };
  worker: {
    url: string;
    timeout_ms: number;
  };
  auth: {
    session_ttl_seconds: number;
    session_cookie_name: string;
    secret_key: string;
  };
  search: {
    default_limit: number;
    max_limit: number;
    rrf_k: number;
    ef_search: number;
  };
  embedding: {
    model: string;
    model_path: string;
    device: string;
    batch_size: number;
    worker_port: number;
  };
  rate_limit: {
    max: number;
    time_window_ms: number;
  };
  jobs: {
    expireInSeconds: number;
    retentionDays: number;
  };
  ui: {
    serve: boolean;
    dist_path: string;
  };
  lru_cache: {
    max_size: number;
    ttl_ms: number;
  };
}

function loadYaml(): Partial<AppConfig> {
  const yamlPath = path.join(__dirname, '..', 'config', 'default.yaml');
  if (!fs.existsSync(yamlPath)) {
    return {};
  }
  try {
    return (yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as Partial<AppConfig>) ?? {};
  } catch {
    return {};
  }
}

function getEnv(key: string, fallback?: string): string {
  return process.env[key] ?? fallback ?? '';
}

function getEnvInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function getEnvBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (!v) return fallback;
  return v === 'true' || v === '1';
}

function buildConfig(): AppConfig {
  const yaml = loadYaml();

  return {
    server: {
      host: getEnv('DOCVAULT_SERVER_HOST', yaml.server?.host ?? '127.0.0.1'),
      port: getEnvInt('DOCVAULT_SERVER_PORT', yaml.server?.port ?? 3000),
      log_level: getEnv('DOCVAULT_SERVER_LOG_LEVEL', yaml.server?.log_level ?? 'info'),
      body_limit: getEnvInt('DOCVAULT_SERVER_BODY_LIMIT', yaml.server?.body_limit ?? 2097152),
    },
    database: {
      url: getEnv('DOCVAULT_DATABASE_URL', yaml.database?.url ?? ''),
      pool_min: getEnvInt('DOCVAULT_DATABASE_POOL_MIN', yaml.database?.pool_min ?? 2),
      pool_max: getEnvInt('DOCVAULT_DATABASE_POOL_MAX', yaml.database?.pool_max ?? 10),
      pool_idle_timeout_ms: getEnvInt(
        'DOCVAULT_DATABASE_POOL_IDLE_TIMEOUT_MS',
        yaml.database?.pool_idle_timeout_ms ?? 30000
      ),
    },
    worker: {
      url: getEnv('DOCVAULT_WORKER_URL', yaml.worker?.url ?? 'http://127.0.0.1:8001'),
      timeout_ms: getEnvInt('DOCVAULT_WORKER_TIMEOUT_MS', yaml.worker?.timeout_ms ?? 5000),
    },
    auth: {
      session_ttl_seconds: getEnvInt(
        'DOCVAULT_AUTH_SESSION_TTL_SECONDS',
        yaml.auth?.session_ttl_seconds ?? 604800
      ),
      session_cookie_name: getEnv(
        'DOCVAULT_AUTH_SESSION_COOKIE_NAME',
        yaml.auth?.session_cookie_name ?? 'docvault_session'
      ),
      secret_key: getEnv('DOCVAULT_AUTH_SECRET_KEY', yaml.auth?.secret_key ?? ''),
    },
    search: {
      default_limit: getEnvInt('DOCVAULT_SEARCH_DEFAULT_LIMIT', yaml.search?.default_limit ?? 10),
      max_limit: getEnvInt('DOCVAULT_SEARCH_MAX_LIMIT', yaml.search?.max_limit ?? 50),
      rrf_k: getEnvInt('DOCVAULT_SEARCH_RRF_K', yaml.search?.rrf_k ?? 60),
      ef_search: getEnvInt('DOCVAULT_SEARCH_EF_SEARCH', yaml.search?.ef_search ?? 100),
    },
    embedding: {
      model: getEnv('DOCVAULT_EMBEDDING_MODEL', yaml.embedding?.model ?? 'nomic-ai/nomic-embed-text-v1.5'),
      model_path: expandHome(
        getEnv(
          'DOCVAULT_EMBEDDING_MODEL_PATH',
          yaml.embedding?.model_path ?? '~/.cache/docvault/models'
        )
      ),
      device: getEnv('DOCVAULT_EMBEDDING_DEVICE', yaml.embedding?.device ?? 'cuda'),
      batch_size: getEnvInt('DOCVAULT_EMBEDDING_BATCH_SIZE', yaml.embedding?.batch_size ?? 16),
      worker_port: getEnvInt('DOCVAULT_EMBEDDING_WORKER_PORT', yaml.embedding?.worker_port ?? 8001),
    },
    rate_limit: {
      max: getEnvInt('DOCVAULT_RATE_LIMIT_MAX', yaml.rate_limit?.max ?? 200),
      time_window_ms: getEnvInt(
        'DOCVAULT_RATE_LIMIT_TIME_WINDOW_MS',
        yaml.rate_limit?.time_window_ms ?? 60000
      ),
    },
    jobs: {
      expireInSeconds: getEnvInt(
        'DOCVAULT_JOBS_EXPIRE_IN_SECONDS',
        yaml.jobs?.expireInSeconds ?? 120
      ),
      retentionDays: getEnvInt('DOCVAULT_JOBS_RETENTION_DAYS', yaml.jobs?.retentionDays ?? 7),
    },
    ui: {
      serve: getEnvBool('DOCVAULT_UI_SERVE', yaml.ui?.serve ?? true),
      dist_path: getEnv('DOCVAULT_UI_DIST_PATH', yaml.ui?.dist_path ?? './dist/ui'),
    },
    lru_cache: {
      max_size: getEnvInt('DOCVAULT_LRU_CACHE_MAX_SIZE', yaml.lru_cache?.max_size ?? 1000),
      ttl_ms: getEnvInt('DOCVAULT_LRU_CACHE_TTL_MS', yaml.lru_cache?.ttl_ms ?? 300000),
    },
  };
}

export const config = buildConfig();

const keyBuf = Buffer.from(config.auth.secret_key ?? '', 'hex');
if (keyBuf.length !== 32) {
  throw new Error(
    'DOCVAULT_AUTH_SECRET_KEY must be a 64-character hex string. ' +
    'Generate one with: openssl rand -hex 32'
  );
}

export type { AppConfig };
