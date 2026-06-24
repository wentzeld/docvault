import { Command } from 'commander';
import readline from 'readline';
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { connectDb } from '../lib/db-connect.js';

function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    // Disable echo
    const stderr = process.stderr as NodeJS.WriteStream & {
      _handle?: { setRawMode?: (raw: boolean) => void };
    };
    if (stderr._handle?.setRawMode) {
      stderr._handle.setRawMode(true);
    }

    process.stderr.write(prompt);
    let password = '';

    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (char: string) => {
      if (char === '\n' || char === '\r' || char === '') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stderr.write('\n');
        rl.close();
        resolve(password);
      } else if (char === '') {
        process.exit(1);
      } else if (char === '') {
        password = password.slice(0, -1);
      } else {
        password += char;
      }
    });
  });
}

export function userCommand(): Command {
  const cmd = new Command('user').description('Manage local user accounts');

  cmd
    .command('set-password')
    .description('Set or update the password for a user account')
    .requiredOption('--username <username>', 'Username to set password for')
    .action(async (opts: { username: string }) => {
      const { db, pool } = await connectDb();

      try {
        const password = await promptPassword(`New password for '${opts.username}': `);
        const confirm = await promptPassword('Confirm password: ');

        if (password !== confirm) {
          console.error('Passwords do not match.');
          process.exit(1);
        }

        if (password.length < 8) {
          console.error('Password must be at least 8 characters.');
          process.exit(1);
        }

        const hash = await bcrypt.hash(password, 12);

        await db
          .insert(users)
          .values({ username: opts.username, password_hash: hash })
          .onConflictDoUpdate({
            target: users.username,
            set: { password_hash: hash, updated_at: sql`now()` },
          });

        console.log(`Password set for user '${opts.username}'.`);
      } finally {
        await pool.end();
      }
      process.exit(0);
    });

  return cmd;
}
