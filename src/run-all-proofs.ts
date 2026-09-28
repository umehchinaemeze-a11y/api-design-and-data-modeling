import { runMigration } from './migrate.js';
import { seedDatabase } from './seed.js';
import { runFiveRepresentativeQueries } from './queries.js';
import { runExplainPlans } from './explain.js';
import { runInvalidInvariantTests } from './test-invariants.js';
import { pool, query } from './db.js';

async function runAllProofs() {
  console.log('================================================================');
  console.log('URBANGLIDE SYSTEM PROOF VERIFICATION SUITE');
  console.log('================================================================\n');

  try {
    // 1. Run Migration
    await runMigration();

    // 2. Run Seed
    await seedDatabase();

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

    // 6. Run Three Invalid Invariants
    const invariantResults = await runInvalidInvariantTests();
    const allInvariantsPassed = invariantResults.every(r => r.passed);
    if (!allInvariantsPassed) {
      throw new Error('Not all invalid invariant tests passed.');
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
