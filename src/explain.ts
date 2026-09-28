import fs from 'fs';
import path from 'path';
import { pool, query } from './db.js';

export async function runExplainPlans() {
  console.log('================================================================');
  console.log('EXPLAIN ANALYZE QUERY PLAN VERIFICATION');
  console.log('================================================================\n');

  const evidenceDir = path.join(process.cwd(), 'evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  // Heavy Query A: Driver Available Queue (Action 2)
  // Queries pending trips with status = 'REQUESTED' ordered by requested_at DESC
  console.log('--- [QUERY PLAN 1] Driver Available Queue ---');
  console.log('Target Index: idx_trips_driver_available_queue (status, requested_at DESC) WHERE status = \'REQUESTED\'');
  const plan1Rows = await query(`
    EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
    SELECT 
      id AS trip_id,
      pickup_address,
      destination_address,
      fare_amount_minor,
      currency,
      requested_at
    FROM trips
    WHERE status = 'REQUESTED' 
      AND driver_id IS NULL
    ORDER BY requested_at DESC
    LIMIT 10;
  `);

  const plan1Text = plan1Rows.map((r: any) => r['QUERY PLAN']).join('\n');
  console.log(plan1Text);
  fs.writeFileSync(
    path.join(evidenceDir, 'explain_query_1.txt'),
    `--- EXPLAIN ANALYZE: Driver Available Pending Queue ---\nTarget Index: idx_trips_driver_available_queue\n\n${plan1Text}\n`
  );

  // Heavy Query B: Rider Completed Trip History (Action 4)
  // Queries completed trips for a specific rider ordered by completed_at DESC
  console.log('\n--- [QUERY PLAN 2] Rider Completed Trip History ---');
  console.log('Target Index: idx_trips_rider_completed (rider_id, completed_at DESC) WHERE status = \'COMPLETED\'');
  const riderRow = (await query(`SELECT id, name FROM riders WHERE email = 'amara.okafor@example.com';`))[0];
  const plan2Rows = await query(`
    EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
    SELECT 
      t.id AS trip_id,
      t.status,
      t.fare_amount_minor,
      t.currency,
      t.driver_name_snapshot,
      t.vehicle_description_snapshot,
      t.pickup_address,
      t.destination_address,
      t.completed_at,
      p.status AS payment_status
    FROM trips t
    LEFT JOIN payments p ON p.trip_id = t.id
    WHERE t.rider_id = $1 
      AND t.status = 'COMPLETED'
    ORDER BY t.completed_at DESC
    LIMIT 5 OFFSET 0;
  `, [riderRow.id]);

  const plan2Text = plan2Rows.map((r: any) => r['QUERY PLAN']).join('\n');
  console.log(plan2Text);
  fs.writeFileSync(
    path.join(evidenceDir, 'explain_query_2.txt'),
    `--- EXPLAIN ANALYZE: Rider Completed Trip History ---\nTarget Index: idx_trips_rider_completed\nRider: ${riderRow.name} (${riderRow.id})\n\n${plan2Text}\n`
  );

  // Also verify Rider Active Trip partial index scan
  console.log('\n--- [QUERY PLAN 3] Rider Active Trip Lookup ---');
  console.log('Target Index: idx_trips_single_active_rider (rider_id) WHERE status IN (\'REQUESTED\', \'ACCEPTED\', \'IN_PROGRESS\')');
  const plan3Rows = await query(`
    EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT)
    SELECT 
      id, status, driver_name_snapshot, fare_amount_minor, requested_at
    FROM trips
    WHERE rider_id = $1 
      AND status IN ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS')
    LIMIT 1;
  `, [riderRow.id]);
  const plan3Text = plan3Rows.map((r: any) => r['QUERY PLAN']).join('\n');
  console.log(plan3Text);

  console.log('\n================================================================');
  console.log('QUERY PLANS CAPTURED AND RECORDED TO EVIDENCE DIRECTORY');
  console.log('================================================================\n');
}

if (process.argv[1]?.endsWith('explain.ts') || process.argv[1]?.endsWith('explain.js')) {
  runExplainPlans()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
