import { Command } from 'commander';
import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { tokens } from '../../db/schema.js';
import { connectDb } from '../lib/db-connect.js';
import { generateBearerToken } from '../../api/lib/crypto.js';

export function tokenCommand(): Command {
  const cmd = new Command('token').description('Manage API bearer tokens');

  cmd
    .command('create')
    .description('Create a new API bearer token (shown once, not stored)')
    .requiredOption('--name <name>', 'Human-readable label for this token')
    .requiredOption('--agent-id <agentId>', 'Agent ID this token represents')
    .option('--scopes <scopes>', 'Comma-separated scopes', 'read,write')
    .option('--expires <iso8601>', 'Expiry date (ISO 8601). Omit for never.')
    .action(async (opts: { name: string; agentId: string; scopes: string; expires?: string }) => {
      const { db, pool } = await connectDb();

      try {
        const raw = generateBearerToken();
        const hash = await bcrypt.hash(raw, 12);
        const lookupHash = createHash('sha256').update(raw).digest('hex');

        const scopeList = opts.scopes.split(',').map((s) => s.trim());
        const expiresAt = opts.expires ? new Date(opts.expires) : null;

        const [row] = await db
          .insert(tokens)
          .values({
            name: opts.name,
            agent_id: opts.agentId,
            hash,
            lookup_hash: lookupHash,
            scopes: scopeList,
            expires_at: expiresAt ?? undefined,
            revoked: false,
          })
          .returning({ id: tokens.id });

        console.log('');
        console.log('Token created successfully.');
        console.log(`  Token ID:  ${row!.id}`);
        console.log(`  Agent ID:  ${opts.agentId}`);
        console.log(`  Scopes:    ${scopeList.join(', ')}`);
        if (expiresAt) {
          console.log(`  Expires:   ${expiresAt.toISOString()}`);
        } else {
          console.log('  Expires:   never');
        }
        console.log('');
        console.log('Bearer token (save this — shown ONCE, never stored):');
        console.log('');
        console.log(`  ${raw}`);
        console.log('');
        console.log('Usage:  Authorization: Bearer <token>');
        console.log('');
      } finally {
        await pool.end();
      }
      process.exit(0);
    });

  cmd
    .command('list')
    .description('List all API bearer tokens')
    .action(async () => {
      const { db, pool } = await connectDb();

      try {
        const rows = await db
          .select({
            id: tokens.id,
            name: tokens.name,
            agent_id: tokens.agent_id,
            scopes: tokens.scopes,
            last_used_at: tokens.last_used_at,
            expires_at: tokens.expires_at,
            revoked: tokens.revoked,
            created_at: tokens.created_at,
          })
          .from(tokens);

        if (rows.length === 0) {
          console.log('No tokens found.');
          return;
        }

        console.log('');
        console.log('API Tokens:');
        console.log('─'.repeat(80));
        for (const row of rows) {
          const status = row.revoked ? '[REVOKED]' : '[active]';
          const lastUsed = row.last_used_at
            ? row.last_used_at.toISOString()
            : 'never';
          const expires = row.expires_at
            ? row.expires_at.toISOString()
            : 'never';
          console.log(
            `${status} ${row.id.slice(0, 8)}... | ${row.name} | agent: ${row.agent_id} | scopes: ${row.scopes.join(',')} | last used: ${lastUsed} | expires: ${expires}`
          );
        }
        console.log('─'.repeat(80));
        console.log(`Total: ${rows.length}`);
        console.log('');
      } finally {
        await pool.end();
      }
      process.exit(0);
    });

  cmd
    .command('revoke')
    .description('Revoke an API bearer token')
    .requiredOption('--id <id>', 'Token UUID to revoke')
    .action(async (opts: { id: string }) => {
      const { db, pool } = await connectDb();

      try {
        const [existing] = await db
          .select({ id: tokens.id, name: tokens.name })
          .from(tokens)
          .where(eq(tokens.id, opts.id))
          .limit(1);

        if (!existing) {
          console.error(`Token not found: ${opts.id}`);
          process.exit(1);
        }

        await db
          .update(tokens)
          .set({ revoked: true })
          .where(eq(tokens.id, opts.id));

        console.log(`Token '${existing.name}' (${opts.id}) revoked.`);
      } finally {
        await pool.end();
      }
      process.exit(0);
    });

  return cmd;
}
