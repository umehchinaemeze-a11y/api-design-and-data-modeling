import fs from 'fs';
import path from 'path';
import { pool, query } from './db.js';

export async function runFiveRepresentativeQueries() {
  console.log('================================================================');
  console.log('EXECUTION OF FIVE REPRESENTATIVE QUERIES');
  console.log('================================================================\n');

  const evidenceDir = path.join(process.cwd(), 'evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  // 1. Query 1: Rider's active trip lookup (Action 3: Track an Active Trip)
  console.log('--- [QUERY 1] Rider Active Trip Lookup (Action 3: Track an Active Trip) ---');
  // Amara Okafor (first rider) has an active ACCEPTED trip
  const riderRow = (await query(`SELECT id, name FROM riders WHERE email = 'amara.okafor@example.com';`))[0];
  const query1Sql = `
    SELECT 
      t.id AS trip_id,
      t.status,
      t.driver_name_snapshot,
      t.vehicle_description_snapshot,
      t.pickup_address,
      t.destination_address,
      t.fare_amount_minor,
      t.currency,
      t.requested_at,
      t.accepted_at,
      t.started_at
    FROM trips t
    WHERE t.rider_id = $1 
      AND t.status IN ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS')
    LIMIT 1;
  `;
  const res1 = await query(query1Sql, [riderRow.id]);
  console.log(`Rider: ${riderRow.name} (${riderRow.id})`);
  console.log('Result:', JSON.stringify(res1, null, 2));
  fs.writeFileSync(
    path.join(evidenceDir, 'query_1.txt'),
    `--- QUERY 1: Rider Active Trip Lookup ---\nRider: ${riderRow.name} (${riderRow.id})\nSQL:\n${query1Sql.trim()}\n\nOUTPUT:\n${JSON.stringify(res1, null, 2)}\n`
  );

  // 2. Query 2: Driver Available Queue (Action 2: Accept and Start a Trip)
  console.log('\n--- [QUERY 2] Driver Available Pending Queue (Action 2: Accept and Start a Trip) ---');
  const query2Sql = `
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
  `;
  const res2 = await query(query2Sql);
  console.log(`Found ${res2.length} pending trips in available queue:`);
  console.log('Result:', JSON.stringify(res2, null, 2));
  fs.writeFileSync(
    path.join(evidenceDir, 'query_2.txt'),
    `--- QUERY 2: Driver Available Pending Queue ---\nSQL:\n${query2Sql.trim()}\n\nOUTPUT:\n${JSON.stringify(res2, null, 2)}\n`
  );

  // 3. Query 3: Trip Detailed Manifest / Audit Receipt (Action 4: Complete and Pay for a Trip)
  console.log('\n--- [QUERY 3] Detailed Trip Manifest & Audit Trail (Action 4: Trip Manifest & Financial Audit) ---');
  // Pick one completed trip that has both a payment and a review
  const completedTripSample = (await query(`
    SELECT t.id 
    FROM trips t 
    JOIN payments p ON p.trip_id = t.id 
    JOIN reviews r ON r.trip_id = t.id 
    WHERE t.status = 'COMPLETED' 
    LIMIT 1;
  `))[0];
  const query3Sql = `
    SELECT 
      t.id AS trip_id,
      t.status,
      t.fare_amount_minor,
      t.currency,
      t.driver_name_snapshot,
      t.vehicle_description_snapshot,
      t.pickup_address,
      t.destination_address,
      t.requested_at,
      t.accepted_at,
      t.started_at,
      t.completed_at,
      p.id AS payment_id,
      p.amount_minor AS payment_amount_minor,
      p.currency AS payment_currency,
      p.status AS payment_status,
      p.provider_reference,
      p.paid_at,
      r.id AS review_id,
      r.rating AS review_rating,
      r.comment AS review_comment
    FROM trips t
    LEFT JOIN payments p ON p.trip_id = t.id
    LEFT JOIN reviews r ON r.trip_id = t.id
    WHERE t.id = $1;
  `;
  const res3 = await query(query3Sql, [completedTripSample.id]);
  console.log(`Trip ID: ${completedTripSample.id}`);
  console.log('Result:', JSON.stringify(res3, null, 2));
  fs.writeFileSync(
    path.join(evidenceDir, 'query_3.txt'),
    `--- QUERY 3: Detailed Trip Manifest & Audit Trail ---\nTrip ID: ${completedTripSample.id}\nSQL:\n${query3Sql.trim()}\n\nOUTPUT:\n${JSON.stringify(res3, null, 2)}\n`
  );

  // 4. Query 4: Rider's Completed Trip History (Action 4: Historical Ledger)
  console.log('\n--- [QUERY 4] Rider Completed Trip History (Paginated) ---');
  const query4Sql = `
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
  `;
  const res4 = await query(query4Sql, [riderRow.id]);
  console.log(`Rider: ${riderRow.name} (${riderRow.id}) completed history:`);
  console.log('Result:', JSON.stringify(res4, null, 2));
  fs.writeFileSync(
    path.join(evidenceDir, 'query_4.txt'),
    `--- QUERY 4: Rider Completed Trip History ---\nRider: ${riderRow.name} (${riderRow.id})\nSQL:\n${query4Sql.trim()}\n\nOUTPUT:\n${JSON.stringify(res4, null, 2)}\n`
  );

  // 5. Query 5: Driver Reputation & Review Summary (Action 5: Review a Completed Trip)
  console.log('\n--- [QUERY 5] Driver Reputation & Review Feed (Action 5: Review Feed) ---');
  const driverRow = (await query(`SELECT id, name FROM drivers WHERE email = 'babatunde.alabi@example.com';`))[0];
  const query5Sql = `
    SELECT 
      r.id AS review_id,
      r.rating,
      r.comment,
      r.created_at,
      t.pickup_address,
      t.destination_address
    FROM reviews r
    JOIN trips t ON t.id = r.trip_id
    WHERE r.driver_id = $1
    ORDER BY r.created_at DESC
    LIMIT 5;
  `;
  const res5 = await query(query5Sql, [driverRow.id]);
  console.log(`Driver: ${driverRow.name} (${driverRow.id}) recent reviews:`);
  console.log('Result:', JSON.stringify(res5, null, 2));
  fs.writeFileSync(
    path.join(evidenceDir, 'query_5.txt'),
    `--- QUERY 5: Driver Reputation & Review Feed ---\nDriver: ${driverRow.name} (${driverRow.id})\nSQL:\n${query5Sql.trim()}\n\nOUTPUT:\n${JSON.stringify(res5, null, 2)}\n`
  );

  console.log('\n================================================================');
  console.log('ALL FIVE REPRESENTATIVE QUERIES EXECUTED AND SAVED TO EVIDENCE');
  console.log('================================================================\n');
}

if (process.argv[1]?.endsWith('queries.ts') || process.argv[1]?.endsWith('queries.js')) {
  runFiveRepresentativeQueries()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
