import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import { config } from '../../config.js';

export type CliDb = ReturnType<typeof drizzle<typeof schema>>;

export async function connectDb(): Promise<{ db: CliDb; pool: Pool }> {
  const dbUrl = config.database.url;
  if (!dbUrl) {
    throw new Error(
      'DOCVAULT_DATABASE_URL not set. Check your .env file or environment.'
    );
  }

  const pool = new Pool({ connectionString: dbUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
