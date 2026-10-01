import fs from 'fs';
import path from 'path';
import { runMigration } from './migrate.js';
import { seedDatabase } from './seed.js';
import { runFiveRepresentativeQueries } from './queries.js';
import { runExplainPlans } from './explain.js';
import { runInvalidInvariantTests } from './test-invariants.js';
import { pool, query } from './db.js';

const evidenceDir = path.join(process.cwd(), 'evidence');

function evidencePath(file: string) {
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }
  return path.join(evidenceDir, file);
}

/* The migration log reports what the catalog actually contains after the
 * migration ran. Nothing here is asserted by hand, so the log cannot drift
 * away from the schema it claims to describe. */
async function writeMigrationLog() {
  const [tables, indexes, triggers] = await Promise.all([
    query(`SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;`),
    query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
           AND indexname LIKE 'idx_%' ORDER BY indexname;`),
    query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname;`),
  ]);

  const log = [
    '--- MIGRATION RUN LOG ---',
    `Timestamp: ${new Date().toISOString()}`,
    'Migration: migrations/001_initial_schema.sql',
    'Target: PostgreSQL 16 on port 15436',
    'Database: urbanglide_db',
    '',
    'STATUS: SUCCESS',
    '',
    `Tables created (${tables.length}):`,
    ...tables.map(r => `  - ${r.table_name}`),
    '',
    `Partial / performance indexes created (${indexes.length}):`,
    ...indexes.map(r => `  - ${r.indexname}`),
    '',
    `Lifecycle triggers created (${triggers.length}):`,
    ...triggers.map(r => `  - ${r.tgname}`),
    '',
  ].join('\n');

  fs.writeFileSync(evidencePath('migration_log.txt'), log);
  console.log('  [LOG] evidence/migration_log.txt written from the live catalog.');
}

/* The seed log reports counts read back out of the database, never a
 * hardcoded expectation. */
async function writeSeedLog() {
  const [counts, byStatus] = await Promise.all([
    query(`
      SELECT
        (SELECT count(*) FROM riders)   AS riders,
        (SELECT count(*) FROM drivers)  AS drivers,
        (SELECT count(*) FROM vehicles) AS vehicles,
        (SELECT count(*) FROM trips)    AS trips,
        (SELECT count(*) FROM payments) AS payments,
        (SELECT count(*) FROM reviews)  AS reviews;
    `),
    query(`SELECT status::text, count(*)::int AS n FROM trips GROUP BY status ORDER BY status;`),
  ]);

  const c = counts[0];
  const log = [
    '--- DATABASE SEED LOG ---',
    `Timestamp: ${new Date().toISOString()}`,
    'Source: src/seed.ts (deterministic UUID and timestamp fixtures)',
    'Database: urbanglide_db',
    '',
    'STATUS: SUCCESS',
    '',
    'Row counts read back from the database:',
    `  - riders:   ${c.riders}`,
    `  - drivers:  ${c.drivers}`,
    `  - vehicles: ${c.vehicles}`,
    `  - trips:    ${c.trips}`,
    `  - payments: ${c.payments}`,
    `  - reviews:  ${c.reviews}`,
    '',
    'Trips by status:',
    ...byStatus.map(r => `  - ${r.status}: ${r.n}`),
    '',
  ].join('\n');

  fs.writeFileSync(evidencePath('seed_log.txt'), log);
  console.log('  [LOG] evidence/seed_log.txt written from live row counts.');
}

async function runAllProofs() {
  console.log('================================================================');
  console.log('URBANGLIDE SYSTEM PROOF VERIFICATION SUITE');
  console.log('================================================================\n');

  try {
    // 1. Run Migration
    await runMigration();
    await writeMigrationLog();

    // 2. Run Seed
    await seedDatabase();
    await writeSeedLog();

    // 3. Test Foreign Keys & Structural Integrity
    console.log('\n--- [INTEGRITY CHECK] Verifying Foreign Key & Deletion Policies ---');
    const rider = (await query('SELECT id FROM riders LIMIT 1;'))[0];
    try {
      await query(`DELETE FROM riders WHERE id = '${rider.id}';`);
      throw new Error('Expected ON DELETE RESTRICT on riders to prevent hard deletion while trips exist.');
    } catch (err: any) {
      if (err.code === '23503') {
        console.log('✅ PASS: ON DELETE RESTRICT actively protects historical rider integrity (foreign_key_violation 23503).');
      } else {
        throw err;
      }
    }

    // 4. Run Five Representative Queries
    await runFiveRepresentativeQueries();

    // 5. Run Query Plans
    await runExplainPlans();

    // 6. Run Invariant Proofs (6 rejections + 1 acceptance control)
    const invariantResults = await runInvalidInvariantTests();
    const allInvariantsPassed = invariantResults.every(r => r.passed);
    if (!allInvariantsPassed) {
      throw new Error('Not all invariant proofs passed.');
    }
    for (const r of invariantResults) {
      console.log(`   [PROOF ${r.testNumber}] ${r.passed ? 'PASS' : 'FAIL'} - ${r.title}`);
    }

    console.log('\n================================================================');
    console.log('🎉 ALL ARCHITECTURAL PROOFS COMPLETED SUCCESSFULLY (VERDICT: PASS)');
    console.log('================================================================\n');
  } finally {
    await pool.end();
  }
}

runAllProofs().catch((err) => {
  console.error('PROOFS FAILED:', err);
  process.exit(1);
});
