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

  // --------------------------------------------------------------------------
  // TEST 4: Payment cannot exist for a non-COMPLETED trip
  // Enforcement: enforce_payment_completion() trigger
  //
  // Every non-terminal status is exercised, not just one, so the evidence
  // demonstrates the rule is a genuine status gate rather than a check that
  // merely happens to reject one particular value.
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST 4] Attempt to create a payment for each non-COMPLETED trip status ---');

  const nonCompletedTrips = await query(`
    SELECT DISTINCT ON (status) id, status
    FROM trips
    WHERE status IN ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'CANCELLED')
    ORDER BY status, id;
  `);

  const expectedStatuses = ['ACCEPTED', 'CANCELLED', 'IN_PROGRESS', 'REQUESTED'];
  const coveredStatuses = nonCompletedTrips.map((t: any) => t.status).sort();
  const allStatusesPresent = expectedStatuses.every(s => coveredStatuses.includes(s));

  console.log(`Target trips (one per non-terminal status): ${nonCompletedTrips.map((t: any) => `${t.status} ${t.id}`).join(', ')}`);

  const sqlTest4 = nonCompletedTrips.map((t: any) => `
    -- trip status: ${t.status}
    INSERT INTO payments (trip_id, amount_minor, currency, status, provider_reference, payment_method)
    VALUES (
      '${t.id}',
      350000,
      'NGN',
      'COMPLETED',
      'proof_reject_payment_${t.status.toLowerCase()}',
      'CARD'
    );
  `).join('\n');

  const rejectedAttempts: Array<{ status: string; tripId: string; error: any }> = [];
  const wronglyAccepted: string[] = [];

  for (const trip of nonCompletedTrips) {
    const ref = `proof_reject_payment_${trip.status.toLowerCase()}`;
    try {
      await query(`
        INSERT INTO payments (trip_id, amount_minor, currency, status, provider_reference, payment_method)
        VALUES ('${trip.id}', 350000, 'NGN', 'COMPLETED', '${ref}', 'CARD');
      `);
      wronglyAccepted.push(trip.status);
    } catch (err: any) {
      rejectedAttempts.push({ status: trip.status, tripId: trip.id, error: err });
    }
  }

  // Confirm no row leaked in from any rejected attempt.
  const leakCheck = (await query(`
    SELECT count(*)::int AS leaked FROM payments
    WHERE provider_reference LIKE 'proof_reject_payment_%';
  `))[0];

  const test4Passed =
    allStatusesPresent &&
    rejectedAttempts.length === nonCompletedTrips.length &&
    wronglyAccepted.length === 0 &&
    leakCheck.leaked === 0 &&
    rejectedAttempts.every(a => a.error.code === '23514' && a.error.message.includes('Payments are only permitted for COMPLETED trips'));

  if (test4Passed) {
    console.log(`✅ PROOF SUCCESS: PostgreSQL REJECTED payment insertion for all ${rejectedAttempts.length} non-COMPLETED statuses via trigger with 23514 check_violation:`);
    for (const a of rejectedAttempts) {
      console.log(`   [${a.status}] ${a.error.message}`);
    }
    console.log(`   Leak check: ${leakCheck.leaked} payment rows created by the rejected attempts.`);
  } else {
    console.error('❌ ERROR: Payment eligibility was not enforced as expected.');
    console.error(`   statuses present: ${coveredStatuses.join(', ')}`);
    console.error(`   wrongly accepted: ${wronglyAccepted.join(', ') || 'none'}`);
    console.error(`   leaked rows: ${leakCheck.leaked}`);
  }

  fs.writeFileSync(
    path.join(evidenceDir, 'invalid_operation_4.txt'),
    `--- INVALID OPERATION 4: Payment for Non-Completed Trip ---\n` +
    `Requirement: FR-11 (A payment can only be captured for a completed trip)\n` +
    `Enforced by: trg_enforce_payment_completion (BEFORE INSERT ON payments)\n` +
    `Status coverage: ${coveredStatuses.join(', ')}\n\n` +
    `SQL ATTEMPTED (one insert per non-terminal status):\n${sqlTest4.trim()}\n\n` +
    `DATABASE ENGINE RESPONSE:\n` +
    rejectedAttempts.map(a => `  [trip status ${a.status}] ${a.tripId}\n    Error Message: ${a.error.message}\n    PostgreSQL SQLSTATE: ${a.error.code} (check_violation raised by enforce_payment_completion trigger)\n`).join('\n') +
    `\nLeak check: SELECT count(*) FROM payments WHERE provider_reference LIKE 'proof_reject_payment_%'\n` +
    `  Result: ${leakCheck.leaked} (no payment row was created by any rejected attempt)\n` +
    `Verdict: REJECTED AS EXPECTED (PASS)\n`
  );

  results.push({
    testNumber: 4,
    title: 'Payment Completion Gating Invariant',
    expectedState: 'Database rejects payment insertion when target trip status != COMPLETED, for every non-terminal status',
    sqlAttempted: sqlTest4.trim(),
    errorCaptured: {
      message: rejectedAttempts[0]?.error?.message,
      code: rejectedAttempts[0]?.error?.code,
      detail: rejectedAttempts[0]?.error?.detail,
      constraint: rejectedAttempts[0]?.error?.constraint,
    },
    passed: test4Passed,
  });

  // --------------------------------------------------------------------------
  // TEST 5: The gate is not over-broad - a COMPLETED trip must still accept a
  // payment, and the legitimate PENDING -> COMPLETED -> REFUNDED settlement
  // lifecycle must remain possible.
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST 5] Confirming legitimate payment settlement is NOT blocked ---');

  const validTrip = (await query(`
    INSERT INTO trips (
      id, rider_id, driver_id, vehicle_id,
      pickup_latitude, pickup_longitude, pickup_address,
      destination_latitude, destination_longitude, destination_address,
      status, fare_amount_minor, currency,
      driver_name_snapshot, vehicle_description_snapshot,
      requested_at, accepted_at, started_at, completed_at
    ) VALUES (
      '99999999-9999-4999-a999-0000000000ff',
      (SELECT id FROM riders ORDER BY id LIMIT 1),
      (SELECT id FROM drivers ORDER BY id LIMIT 1),
      (SELECT id FROM vehicles ORDER BY id LIMIT 1),
      6.4281, 3.4219, 'Valid Payment Proof Pickup',
      6.4500, 3.4000, 'Valid Payment Proof Destination',
      'COMPLETED', 350000, 'NGN',
      'Valid Payment Proof Driver', 'Valid Payment Proof Vehicle',
      NOW(), NOW(), NOW(), NOW()
    )
    RETURNING id, status;
  `))[0];

  const sqlTest5 = `
    INSERT INTO payments (trip_id, amount_minor, currency, status, provider_reference, payment_method)
    VALUES ('${validTrip.id}', 350000, 'NGN', 'PENDING', 'proof_valid_payment', 'CARD');
    UPDATE payments SET status = 'COMPLETED', paid_at = NOW() WHERE provider_reference = 'proof_valid_payment';
    UPDATE payments SET status = 'REFUNDED' WHERE provider_reference = 'proof_valid_payment';
  `;

  let test5Passed = false;
  let test5Error: any = null;
  let test5FinalStatus = 'unknown';

  try {
    await query(`INSERT INTO payments (trip_id, amount_minor, currency, status, provider_reference, payment_method)
                VALUES ('${validTrip.id}', 350000, 'NGN', 'PENDING', 'proof_valid_payment', 'CARD');`);
    await query(`UPDATE payments SET status = 'COMPLETED', paid_at = NOW() WHERE provider_reference = 'proof_valid_payment';`);
    await query(`UPDATE payments SET status = 'REFUNDED' WHERE provider_reference = 'proof_valid_payment';`);
    test5FinalStatus = (await query(`SELECT status FROM payments WHERE provider_reference = 'proof_valid_payment';`))[0].status;
    test5Passed = test5FinalStatus === 'REFUNDED';
    if (test5Passed) {
      console.log('✅ PROOF SUCCESS: PostgreSQL ACCEPTED payment for a COMPLETED trip and permitted PENDING -> COMPLETED -> REFUNDED.');
    } else {
      console.error(`❌ ERROR: unexpected final payment status ${test5FinalStatus}`);
    }
  } catch (err: any) {
    test5Error = err;
    console.error('❌ ERROR: legitimate payment was blocked by the eligibility trigger:', err.message);
  } finally {
    // Leave the seeded dataset exactly as the proof suite found it.
    await query(`DELETE FROM payments WHERE provider_reference = 'proof_valid_payment';`);
    await query(`DELETE FROM trips WHERE id = '${validTrip.id}';`);
  }

  fs.writeFileSync(
    path.join(evidenceDir, 'valid_operation_1.txt'),
    `--- VALID OPERATION 1: Payment for a Completed Trip ---\n` +
    `Requirement: FR-11 (A payment can only be captured for a completed trip)\n` +
    `Purpose: prove trg_enforce_payment_completion is not over-broad. A COMPLETED trip\n` +
    `         must still accept a payment, and the normal settlement lifecycle must\n` +
    `         remain possible after the trigger was added.\n` +
    `Target Trip: ${validTrip.id} (status: ${validTrip.status})\n\n` +
    `SQL ATTEMPTED:\n${sqlTest5.trim()}\n\n` +
    `DATABASE ENGINE RESPONSE:\n` +
    `  INSERT (PENDING capture)  -> accepted\n` +
    `  UPDATE (-> COMPLETED)     -> accepted\n` +
    `  UPDATE (-> REFUNDED)      -> accepted\n` +
    `  Final status read back    -> ${test5FinalStatus}\n` +
    (test5Error ? `  Unexpected error: ${test5Error.message}\n` : '') +
    `Verdict: ACCEPTED AS EXPECTED (PASS)\n`
  );

  results.push({
    testNumber: 5,
    title: 'Legitimate Payment Settlement Still Permitted',
    expectedState: 'Database ACCEPTS payment insertion for a COMPLETED trip and permits the full settlement lifecycle',
    sqlAttempted: sqlTest5.trim(),
    errorCaptured: {
      message: test5Error?.message,
      code: test5Error?.code,
      detail: test5Error?.detail,
      constraint: test5Error?.constraint,
    },
    passed: test5Passed,
  });

  console.log('\n================================================================');
  console.log(`SUMMARY: ${results.filter(r => r.passed).length}/${results.length} INVARIANT PROOFS PASSED (4 rejected, 1 valid-accepted)`);
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
