#!/usr/bin/env tsx
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb, getPool, closeDb } from './index.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runMigrations(): Promise<void> {
  console.log('Running database migrations...');

  const db = getDb();
  const pool = getPool();

  try {
    // Run Drizzle-managed migrations
    const migrationsFolder = path.join(__dirname, 'migrations');
    await migrate(db, { migrationsFolder });
    console.log('Drizzle migrations complete.');

    // Apply hand-written SQL migrations (vector index, triggers etc.)
    const rawSqlPath = path.join(__dirname, 'migrations', '0001_initial.sql');
    if (fs.existsSync(rawSqlPath)) {
      const sql = fs.readFileSync(rawSqlPath, 'utf-8');
      const client = await pool.connect();
      try {
        await client.query(sql);
        console.log('Raw SQL migration 0001_initial.sql applied.');
      } finally {
        client.release();
      }
    }

    console.log('All migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await closeDb();
  }
}

runMigrations();
