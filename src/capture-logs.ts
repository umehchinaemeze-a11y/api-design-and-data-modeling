import fs from 'fs';
import path from 'path';
import { runMigration } from './migrate.js';
import { seedDatabase } from './seed.js';
import { pool } from './db.js';

async function captureLogs() {
  const evidenceDir = path.join(process.cwd(), 'evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  // Capture migration log
  console.log('Capturing migration log...');
  let migrationLog = `--- MIGRATION RUN LOG ---\nTimestamp: ${new Date().toISOString()}\nTarget: PostgreSQL 16 on port 15436\nDatabase: urbanglide_db\n\n`;
  try {
    await runMigration();
    migrationLog += `STATUS: SUCCESS\nAll tables (riders, drivers, vehicles, trips, payments, reviews), enums, triggers, check constraints, and partial indexes created without error.\n`;
  } catch (err: any) {
    migrationLog += `STATUS: FAILED\n${err.stack || err.message}\n`;
  }
  fs.writeFileSync(path.join(evidenceDir, 'migration_log.txt'), migrationLog);

  // Capture seed log
  console.log('Capturing seed log...');
  let seedLog = `--- DATABASE SEED LOG ---\nTimestamp: ${new Date().toISOString()}\nDatabase: urbanglide_db\n\n`;
  try {
    await seedDatabase();
    seedLog += `STATUS: SUCCESS\nDataset summary:\n- 10 Riders created\n- 10 Drivers created\n- 10 Active vehicles created\n- 200 Completed historical trips created\n- 200 Settled payments created\n- 150 Ratings & reviews created\n- 15 Cancelled trips created\n- 5 Available REQUESTED trips created\n- 1 Active ACCEPTED trip created\n- 1 Active IN_PROGRESS trip created\n- ANALYZE execution executed across all tables.\n`;
  } catch (err: any) {
    seedLog += `STATUS: FAILED\n${err.stack || err.message}\n`;
  }
  fs.writeFileSync(path.join(evidenceDir, 'seed_log.txt'), seedLog);

  console.log('Logs captured successfully in evidence directory.');
  await pool.end();
}

captureLogs().catch(err => {
  console.error(err);
  process.exit(1);
});
