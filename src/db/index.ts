import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { config } from '../config.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const dbUrl = config.database.url;
    if (!dbUrl) {
      throw new Error(
        'DOCVAULT_DATABASE_URL or config.database.url is required'
      );
    }
    pool = new Pool({
      connectionString: dbUrl,
      min: config.database.pool_min,
      max: config.database.pool_max,
      idleTimeoutMillis: config.database.pool_idle_timeout_ms,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err);
    });
  }
  return pool;
}

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

let db: DbClient | null = null;

export function getDb(): DbClient {
  if (!db) {
    db = drizzle(getPool(), { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

export { schema };
