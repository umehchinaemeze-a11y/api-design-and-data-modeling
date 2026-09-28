import fs from 'fs';
import path from 'path';
import { pool } from './db.js';

export async function runMigration() {
  console.log('--- [MIGRATION START] Applying 001_initial_schema.sql ---');
  const sqlPath = path.join(process.cwd(), 'migrations', '001_initial_schema.sql');
  const sqlContent = fs.readFileSync(sqlPath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sqlContent);
    await client.query('COMMIT');
    console.log('--- [MIGRATION SUCCESS] All tables, types, triggers, and indexes created successfully. ---');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('--- [MIGRATION FAILED] Error during schema migration: ---', err);
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  runMigration()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
