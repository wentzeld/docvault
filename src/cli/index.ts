#!/usr/bin/env node
import { Command } from 'commander';
import { tokenCommand } from './commands/token.js';
import { userCommand } from './commands/user.js';
import { backupCommand } from './commands/backup.js';
import { reindexCommand } from './commands/reindex.js';

const program = new Command();

program
  .name('docvault')
  .description('DocVault — CLI administration tool')
  .version('1.0.0');

const admin = program.command('admin').description('Admin commands');
admin.addCommand(tokenCommand());
admin.addCommand(userCommand());
admin.addCommand(reindexCommand());

program.addCommand(backupCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error('Error:', err);
  process.exit(1);
});
