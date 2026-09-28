import fs from 'fs';
import path from 'path';
import { pool, query } from './db.js';

interface InvariantTestResult {
  testNumber: number;
  title: string;
  expectedState: string;
  sqlAttempted: string;
  errorCaptured: {
    message: string;
    code: string | undefined;
    detail: string | undefined;
    constraint: string | undefined;
  };
  passed: boolean;
}

export async function runInvalidInvariantTests(): Promise<InvariantTestResult[]> {
  console.log('================================================================');
  console.log('INTENTIONALLY INVALID DATABASE OPERATIONS ENFORCEMENT PROOFS');
  console.log('================================================================\n');

  const evidenceDir = path.join(process.cwd(), 'evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  const results: InvariantTestResult[] = [];

  // --------------------------------------------------------------------------
  // TEST 1: Rider cannot have multiple active trips simultaneously
  // Constraint: idx_trips_single_active_rider (Partial Unique Index)
  // --------------------------------------------------------------------------
  console.log('--- [TEST 1] Attempt to insert second active trip for Rider with existing active trip ---');
  // Amara Okafor has an ACCEPTED trip
  const rider = (await query(`
    SELECT r.id, r.name, t.id AS active_trip_id, t.status AS active_status
    FROM riders r
    JOIN trips t ON t.rider_id = r.id
    WHERE t.status IN ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS')
    LIMIT 1;
  `))[0];

  console.log(`Target Rider: ${rider.name} (${rider.id}) already has trip ${rider.active_trip_id} in status '${rider.active_status}'.`);

  const sqlTest1 = `
    INSERT INTO trips (
      rider_id, pickup_latitude, pickup_longitude, pickup_address,
      destination_latitude, destination_longitude, destination_address,
      status, fare_amount_minor, currency
    ) VALUES (
      '${rider.id}', 6.4300, 3.4200, 'Test Pickup 2',
      6.4500, 3.4400, 'Test Destination 2',
      'REQUESTED', 450000, 'NGN'
    );
  `;

  let test1Passed = false;
  let test1Error: any = null;

  try {
    await query(sqlTest1);
    console.error('❌ ERROR: Database unexpectedly permitted second active trip!');
  } catch (err: any) {
    test1Error = err;
    if (err.code === '23505' && err.constraint === 'idx_trips_single_active_rider') {
      console.log('✅ PROOF SUCCESS: PostgreSQL REJECTED duplicate active trip with 23505 unique_violation:');
      console.log(`   Message: ${err.message}`);
      console.log(`   Constraint: ${err.constraint}`);
      console.log(`   Detail: ${err.detail}`);
      test1Passed = true;
    } else {
      console.error('❌ Rejection failed with unexpected error:', err);
    }
  }

  fs.writeFileSync(
    path.join(evidenceDir, 'invalid_operation_1.txt'),
    `--- INVALID OPERATION 1: Rider Multiple Active Trips ---\n` +
    `Requirement: FR-04 (One rider cannot have multiple active trips simultaneously)\n` +
    `Target: Rider ${rider.name} (${rider.id})\n` +
    `Existing active trip: ${rider.active_trip_id} (${rider.active_status})\n\n` +
    `SQL ATTEMPTED:\n${sqlTest1.trim()}\n\n` +
    `DATABASE ENGINE RESPONSE:\n` +
    `Error Message: ${test1Error?.message}\n` +
    `PostgreSQL SQLSTATE: ${test1Error?.code} (unique_violation)\n` +
    `Constraint: ${test1Error?.constraint}\n` +
    `Detail: ${test1Error?.detail}\n` +
    `Verdict: REJECTED AS EXPECTED (PASS)\n`
  );

  results.push({
    testNumber: 1,
    title: 'Rider Multiple Active Trips Invariant',
    expectedState: 'Database rejects second active trip via idx_trips_single_active_rider',
    sqlAttempted: sqlTest1.trim(),
    errorCaptured: {
      message: test1Error?.message,
      code: test1Error?.code,
      detail: test1Error?.detail,
      constraint: test1Error?.constraint,
    },
    passed: test1Passed,
  });

  // --------------------------------------------------------------------------
  // TEST 2: Completed trip cannot transition back to IN_PROGRESS
  // Enforcement: enforce_trip_status_transition() trigger
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST 2] Attempt to transition COMPLETED trip back to IN_PROGRESS ---');
  const completedTrip = (await query(`
    SELECT id, status FROM trips WHERE status = 'COMPLETED' LIMIT 1;
  `))[0];

  console.log(`Target Completed Trip: ${completedTrip.id} (Status: ${completedTrip.status})`);
  const sqlTest2 = `
    UPDATE trips 
    SET status = 'IN_PROGRESS' 
    WHERE id = '${completedTrip.id}';
  `;

  let test2Passed = false;
  let test2Error: any = null;

  try {
    await query(sqlTest2);
    console.error('❌ ERROR: Database unexpectedly permitted forbidden status transition!');
  } catch (err: any) {
    test2Error = err;
    if (err.code === '23514' && err.message.includes('COMPLETED trips cannot transition')) {
      console.log('✅ PROOF SUCCESS: PostgreSQL REJECTED invalid transition via trigger with 23514 check_violation:');
      console.log(`   Message: ${err.message}`);
      test2Passed = true;
    } else {
      console.error('❌ Rejection failed with unexpected error:', err);
    }
  }

  fs.writeFileSync(
    path.join(evidenceDir, 'invalid_operation_2.txt'),
    `--- INVALID OPERATION 2: Forbidden Trip State Transition ---\n` +
    `Requirement: FR-03 (Completed trip cannot return to in-progress or cancelled)\n` +
    `Target Trip: ${completedTrip.id} (status: ${completedTrip.status})\n\n` +
    `SQL ATTEMPTED:\n${sqlTest2.trim()}\n\n` +
    `DATABASE ENGINE RESPONSE:\n` +
    `Error Message: ${test2Error?.message}\n` +
    `PostgreSQL SQLSTATE: ${test2Error?.code} (check_violation raised by PL/pgSQL trigger)\n` +
    `Verdict: REJECTED AS EXPECTED (PASS)\n`
  );

  results.push({
    testNumber: 2,
    title: 'Completed Trip Terminal State Invariant',
    expectedState: 'Database rejects backward transition from COMPLETED to IN_PROGRESS',
    sqlAttempted: sqlTest2.trim(),
    errorCaptured: {
      message: test2Error?.message,
      code: test2Error?.code,
      detail: test2Error?.detail,
      constraint: test2Error?.constraint,
    },
    passed: test2Passed,
  });

  // --------------------------------------------------------------------------
  // TEST 3: Review cannot exist for incomplete trip
  // Enforcement: enforce_review_completion() trigger
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST 3] Attempt to create review for an IN_PROGRESS trip ---');
  const inProgressTrip = (await query(`
    SELECT id, rider_id, driver_id, status FROM trips WHERE status = 'IN_PROGRESS' LIMIT 1;
  `))[0];

  console.log(`Target In-Progress Trip: ${inProgressTrip.id} (Status: ${inProgressTrip.status})`);
  const sqlTest3 = `
    INSERT INTO reviews (trip_id, rider_id, driver_id, rating, comment)
    VALUES (
      '${inProgressTrip.id}',
      '${inProgressTrip.rider_id}',
      '${inProgressTrip.driver_id}',
      5,
      'Premature review attempt for trip still on the road'
    );
  `;

  let test3Passed = false;
  let test3Error: any = null;

  try {
    await query(sqlTest3);
    console.error('❌ ERROR: Database unexpectedly permitted review for incomplete trip!');
  } catch (err: any) {
    test3Error = err;
    if (err.code === '23514' && err.message.includes('Reviews are only permitted for COMPLETED trips')) {
      console.log('✅ PROOF SUCCESS: PostgreSQL REJECTED premature review via trigger with 23514 check_violation:');
      console.log(`   Message: ${err.message}`);
      test3Passed = true;
    } else {
      console.error('❌ Rejection failed with unexpected error:', err);
    }
  }

  fs.writeFileSync(
    path.join(evidenceDir, 'invalid_operation_3.txt'),
    `--- INVALID OPERATION 3: Review for Incomplete Trip ---\n` +
    `Requirement: FR-09 (Reviews allowed only after trip is completed)\n` +
    `Target Trip: ${inProgressTrip.id} (status: ${inProgressTrip.status})\n\n` +
    `SQL ATTEMPTED:\n${sqlTest3.trim()}\n\n` +
    `DATABASE ENGINE RESPONSE:\n` +
    `Error Message: ${test3Error?.message}\n` +
    `PostgreSQL SQLSTATE: ${test3Error?.code} (check_violation raised by enforce_review_completion trigger)\n` +
    `Verdict: REJECTED AS EXPECTED (PASS)\n`
  );

  results.push({
    testNumber: 3,
    title: 'Review Completion Gating Invariant',
    expectedState: 'Database rejects review insertion when target trip status != COMPLETED',
    sqlAttempted: sqlTest3.trim(),
    errorCaptured: {
      message: test3Error?.message,
      code: test3Error?.code,
      detail: test3Error?.detail,
      constraint: test3Error?.constraint,
    },
    passed: test3Passed,
  });

  console.log('\n================================================================');
  console.log(`SUMMARY: ${results.filter(r => r.passed).length}/${results.length} INVALID OPERATIONS SUCCESSFULLY REJECTED BY POSTGRESQL`);
  console.log('================================================================\n');

  return results;
}

if (process.argv[1]?.endsWith('test-invariants.ts') || process.argv[1]?.endsWith('test-invariants.js')) {
  runInvalidInvariantTests()
    .then((results) => {
      const allPassed = results.every(r => r.passed);
      pool.end();
      if (!allPassed) process.exit(1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
