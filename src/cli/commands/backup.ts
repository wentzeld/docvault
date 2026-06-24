import { Command } from 'commander';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../../config.js';

export function backupCommand(): Command {
  const cmd = new Command('backup').description(
    'Backup the DocVault database to a timestamped .sql.gz file'
  );

  cmd
    .option(
      '--dir <directory>',
      'Backup output directory',
      process.env['DOCVAULT_BACKUP_DIR'] ?? './backups'
    )
    .option('--keep <count>', 'Number of recent backups to keep', '30')
    .action(async (opts: { dir: string; keep: string }) => {
      const backupDir = path.resolve(opts.dir);
      const keepCount = parseInt(opts.keep, 10);

      // Create backup directory if it doesn't exist
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, 19);
      const filename = `docvault_${timestamp}.sql.gz`;
      const filepath = path.join(backupDir, filename);

      const dbUrl = config.database.url;
      if (!dbUrl) {
        console.error('DOCVAULT_DATABASE_URL not configured');
        process.exit(1);
      }

      console.log(`Starting backup to ${filepath}...`);

      // Run pg_dump | gzip
      // Arguments passed as array to child_process.spawn — no shell interpolation
      const pgDump = spawn('pg_dump', ['--no-password', dbUrl], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });

      const gzip = spawn('gzip', ['-c'], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });

      const outStream = fs.createWriteStream(filepath);

      pgDump.stdout.pipe(gzip.stdin);
      gzip.stdout.pipe(outStream);

      await new Promise<void>((resolve, reject) => {
        outStream.on('finish', resolve);
        pgDump.on('error', reject);
        gzip.on('error', reject);
        pgDump.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`pg_dump exited with code ${code ?? 'unknown'}`));
          }
        });
      });

      const stats = fs.statSync(filepath);
      const sizeMb = (stats.size / 1024 / 1024).toFixed(2);
      console.log(`Backup complete: ${filepath} (${sizeMb} MB)`);

      // Rotate old backups
      const backupFiles = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith('docvault_') && f.endsWith('.sql.gz'))
        .map((f) => ({
          name: f,
          path: path.join(backupDir, f),
          mtime: fs.statSync(path.join(backupDir, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      if (backupFiles.length > keepCount) {
        const toDelete = backupFiles.slice(keepCount);
        for (const file of toDelete) {
          fs.unlinkSync(file.path);
          console.log(`Removed old backup: ${file.name}`);
        }
      }

      process.exit(0);
    });

  return cmd;
}
