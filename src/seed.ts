import { pool, query } from './db.js';

/*
 * Deterministic seed identifiers and time base.
 *
 * The schema DEFAULT remains gen_random_uuid() (v4, unpredictable) so NFR-01
 * holds for every row created at runtime. The seed supplies explicit fixed UUIDs
 * purely so that captured evidence is byte-reproducible: the EXPLAIN plans in
 * evidence/ embed the rider UUID in their Index Cond, and the query proofs embed
 * row identifiers, so a random UUID would make every re-run produce a different
 * proof that no longer matches the documented numbers.
 *
 * All identifiers are valid RFC 4122 version 4 shaped (version nibble 4, variant
 * nibble a). Blocks are assigned per table so a fixture is recognisable at a glance.
 */
const SEED_EPOCH = new Date('2026-09-28T08:00:00.000Z');

const uuid = (block: string, n: number) => `${block}-${String(n).padStart(12, '0')}`;

const ID = {
  rider: (n: number) => uuid('11111111-1111-4111-a111', n),
  driver: (n: number) => uuid('22222222-2222-4222-a222', n),
  vehicle: (n: number) => uuid('33333333-3333-4333-a333', n),
  trip: (n: number) => uuid('44444444-4444-4444-a444', n),
  payment: (n: number) => uuid('55555555-5555-4555-a555', n),
  review: (n: number) => uuid('66666666-6666-4666-a666', n),
};

/* Trip numbering follows insertion order, so the blocks below are stable:
 *   1-200 COMPLETED, 201-215 CANCELLED, 216-220 REQUESTED, 221 ACCEPTED, 222 IN_PROGRESS. */
const TRIP = { completed: (i: number) => i, cancelled: (c: number) => 200 + c, requested: (k: number) => 215 + k, accepted: () => 221, inProgress: () => 222 };

export async function seedDatabase() {
  console.log('--- [SEED START] Populating realistic dataset for UrbanGlide ---');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clean existing data
    await client.query('TRUNCATE TABLE reviews, payments, trips, vehicles, drivers, riders CASCADE;');

    // 1. Seed Riders
    const riderRows = await client.query(`
      INSERT INTO riders (id, name, email, phone) VALUES
        ('${ID.rider(1)}', 'Amara Okafor', 'amara.okafor@example.com', '+2348011110001'),
        ('${ID.rider(2)}', 'Chinedu Eze', 'chinedu.eze@example.com', '+2348011110002'),
        ('${ID.rider(3)}', 'Folake Adebayo', 'folake.adebayo@example.com', '+2348011110003'),
        ('${ID.rider(4)}', 'David Chen', 'david.chen@example.com', '+2348011110004'),
        ('${ID.rider(5)}', 'Sarah Jenkins', 'sarah.jenkins@example.com', '+2348011110005'),
        ('${ID.rider(6)}', 'Tariq Al-Mansoor', 'tariq.m@example.com', '+2348011110006'),
        ('${ID.rider(7)}', 'Zainab Bello', 'zainab.b@example.com', '+2348011110007'),
        ('${ID.rider(8)}', 'Kavita Patel', 'kavita.p@example.com', '+2348011110008'),
        ('${ID.rider(9)}', 'Liam O''Connor', 'liam.oc@example.com', '+2348011110009'),
        ('${ID.rider(10)}', 'Ngozi Okonjo', 'ngozi.o@example.com', '+2348011110010')
      RETURNING id, name, email;
    `);
    const riders = riderRows.rows;
    console.log(`✓ Seeded ${riders.length} riders.`);

    // 2. Seed Drivers
    const driverRows = await client.query(`
      INSERT INTO drivers (id, name, email, phone, license_number, status) VALUES
        ('${ID.driver(1)}', 'Babatunde Alabi', 'babatunde.alabi@example.com', '+2348022220001', 'DL-LAG-849201', 'AVAILABLE'),
        ('${ID.driver(2)}', 'Emeka Obi', 'emeka.obi@example.com', '+2348022220002', 'DL-LAG-394812', 'AVAILABLE'),
        ('${ID.driver(3)}', 'Ibrahim Musa', 'ibrahim.musa@example.com', '+2348022220003', 'DL-ABJ-583920', 'ON_TRIP'),
        ('${ID.driver(4)}', 'Kelechi Nwosu', 'kelechi.nwosu@example.com', '+2348022220004', 'DL-LAG-109482', 'ON_TRIP'),
        ('${ID.driver(5)}', 'Olumide Bakare', 'olumide.bakare@example.com', '+2348022220005', 'DL-IBD-749203', 'AVAILABLE'),
        ('${ID.driver(6)}', 'Victor Adeleke', 'victor.adeleke@example.com', '+2348022220006', 'DL-LAG-639102', 'OFFLINE'),
        ('${ID.driver(7)}', 'Ahmed Abubakar', 'ahmed.abubakar@example.com', '+2348022220007', 'DL-KAN-958201', 'AVAILABLE'),
        ('${ID.driver(8)}', 'Samuel Sowande', 'samuel.sowande@example.com', '+2348022220008', 'DL-OGN-492019', 'AVAILABLE'),
        ('${ID.driver(9)}', 'Grace Danjuma', 'grace.danjuma@example.com', '+2348022220009', 'DL-ABJ-849205', 'AVAILABLE'),
        ('${ID.driver(10)}', 'Chima Anyanwu', 'chima.anyanwu@example.com', '+2348022220010', 'DL-ENK-302948', 'AVAILABLE')
      RETURNING id, name, email;
    `);
    const drivers = driverRows.rows;
    console.log(`✓ Seeded ${drivers.length} drivers.`);

    // 3. Seed Vehicles
    const vehicleRows = await client.query(`
      INSERT INTO vehicles (id, driver_id, registration_number, make, model, year, color, vehicle_type, is_active) VALUES
        ('${ID.vehicle(1)}', '${drivers[0].id}', 'APP-102-XY', 'Toyota', 'Corolla', 2021, 'Silver', 'STANDARD', true),
        ('${ID.vehicle(2)}', '${drivers[1].id}', 'KJA-582-AA', 'Honda', 'Civic', 2020, 'Midnight Blue', 'STANDARD', true),
        ('${ID.vehicle(3)}', '${drivers[2].id}', 'RBC-394-CD', 'Hyundai', 'Elantra', 2022, 'Black', 'COMFORT', true),
        ('${ID.vehicle(4)}', '${drivers[3].id}', 'GGE-849-EF', 'Toyota', 'Camry', 2023, 'Pearl White', 'COMFORT', true),
        ('${ID.vehicle(5)}', '${drivers[4].id}', 'LND-920-GH', 'Toyota', 'Sienna', 2019, 'Dark Grey', 'XL', true),
        ('${ID.vehicle(6)}', '${drivers[5].id}', 'EKY-748-JK', 'Kia', 'Cerato', 2020, 'Red', 'STANDARD', true),
        ('${ID.vehicle(7)}', '${drivers[6].id}', 'KRD-391-LM', 'Mercedes-Benz', 'E350', 2021, 'Obsidian Black', 'PREMIUM', true),
        ('${ID.vehicle(8)}', '${drivers[7].id}', 'BDG-592-NP', 'Lexus', 'ES350', 2022, 'Champagne', 'PREMIUM', true),
        ('${ID.vehicle(9)}', '${drivers[8].id}', 'ABJ-820-QR', 'Nissan', 'Altima', 2021, 'Silver', 'STANDARD', true),
        ('${ID.vehicle(10)}', '${drivers[9].id}', 'EN-492-ST', 'Toyota', 'RAV4', 2022, 'Deep Blue', 'COMFORT', true)
      RETURNING id, driver_id, registration_number, make, model, color;
    `);
    const vehicles = vehicleRows.rows;
    console.log(`✓ Seeded ${vehicles.length} vehicles.`);

    // Map driver to vehicle
    const driverVehicleMap = new Map<string, typeof vehicles[0]>();
    for (const v of vehicles) {
      driverVehicleMap.set(v.driver_id, v);
    }

    // 4. Seed Historical COMPLETED Trips (200 trips across the past 30 days)
    console.log('Seeding 200 historical COMPLETED trips with payments and reviews...');
    const locations = [
      { pLat: 6.4281, pLng: 3.4219, pAddr: 'Victoria Island, Adeola Odeku St', dLat: 6.4500, dLng: 3.4000, dAddr: 'Marina Financial Center, Lagos Island', fare: 350000 },
      { pLat: 6.5956, pLng: 3.3375, pAddr: 'Murtala Muhammed Airport T2, Ikeja', dLat: 6.4474, dLng: 3.4880, dAddr: 'Lekki Phase 1, Admiralty Way', fare: 850000 },
      { pLat: 6.4698, pLng: 3.5852, pAddr: 'Chevron Tollgate, Lekki', dLat: 6.4312, dLng: 3.4158, dAddr: 'Eko Hotel & Suites, Victoria Island', fare: 450000 },
      { pLat: 6.6018, pLng: 3.3515, pAddr: 'Ikeja City Mall, Alausa', dLat: 6.5244, dLng: 3.3792, dAddr: 'Yaba Tech Campus, Herbert Macaulay Way', fare: 320000 },
      { pLat: 6.4350, pLng: 3.4500, pAddr: 'Oniru Beach Road, Victoria Island', dLat: 6.4600, dLng: 3.6000, dAddr: 'Ajah Jubilee Bridge, Lekki-Epe', fare: 550000 }
    ];

    const completedTripIds: string[] = [];
    const completedTripDetails: { id: string; rider_id: string; driver_id: string; fare: number }[] = [];

    for (let i = 1; i <= 200; i++) {
      const rider = riders[i % riders.length];
      const driver = drivers[i % drivers.length];
      const vehicle = driverVehicleMap.get(driver.id)!;
      const loc = locations[i % locations.length];
      const daysAgo = Math.floor(i / 7) + 1;
      const requestedAt = new Date(SEED_EPOCH.getTime() - daysAgo * 86400000 - (i % 24) * 3600000);
      const acceptedAt = new Date(requestedAt.getTime() + 120000); // +2 mins
      const startedAt = new Date(acceptedAt.getTime() + 480000); // +8 mins
      const completedAt = new Date(startedAt.getTime() + 1800000); // +30 mins
      const fare = loc.fare + (i * 1000);
      const tripId = ID.trip(TRIP.completed(i));

      const driverSnapshot = driver.name;
      const vehicleSnapshot = `${vehicle.make} ${vehicle.model} (${vehicle.color}) - ${vehicle.registration_number}`;

      await client.query(`
        INSERT INTO trips (
          id,
          rider_id, driver_id, vehicle_id,
          pickup_latitude, pickup_longitude, pickup_address,
          destination_latitude, destination_longitude, destination_address,
          status, fare_amount_minor, currency,
          driver_name_snapshot, vehicle_description_snapshot,
          requested_at, accepted_at, started_at, completed_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7,
          $8, $9, $10,
          'COMPLETED', $11, 'NGN',
          $12, $13,
          $14, $15, $16, $17
        );
      `, [
        tripId,
        rider.id, driver.id, vehicle.id,
        loc.pLat, loc.pLng, loc.pAddr,
        loc.dLat, loc.dLng, loc.dAddr,
        fare,
        driverSnapshot, vehicleSnapshot,
        requestedAt.toISOString(), acceptedAt.toISOString(), startedAt.toISOString(), completedAt.toISOString()
      ]);

      completedTripIds.push(tripId);
      completedTripDetails.push({ id: tripId, rider_id: rider.id, driver_id: driver.id, fare });

      // Seed Payment for this completed trip
      await client.query(`
        INSERT INTO payments (
          id, trip_id, amount_minor, currency, status, provider_reference, payment_method, paid_at, created_at
        ) VALUES (
          $1, $2, $3, 'NGN', 'COMPLETED', $4, 'CARD', $5, $5
        );
      `, [
        ID.payment(i),
        tripId,
        fare,
        `pay_ref_${i}_${tripId.substring(0, 8)}`,
        completedAt.toISOString()
      ]);

      // Seed Review for roughly 75% of completed trips
      if (i % 4 !== 0) {
        const rating = (i % 5 === 0) ? 4 : 5;
        const comments = [
          'Excellent, safe driver and very clean vehicle.',
          'Arrived promptly, smooth drive through Lagos traffic.',
          'Courteous professional, highly recommended!',
          'Great vehicle condition, great AC on a hot afternoon.',
          'Friendly service, took the fastest route without delays.'
        ];
        const comment = comments[i % comments.length];

        await client.query(`
          INSERT INTO reviews (
            id, trip_id, rider_id, driver_id, rating, comment, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7
          );
        `, [
          ID.review(Math.ceil(i * 3 / 4)),
          tripId,
          rider.id,
          driver.id,
          rating,
          comment,
          new Date(completedAt.getTime() + 600000).toISOString()
        ]);
      }
    }

    console.log(`✓ Seeded 200 COMPLETED trips, 200 payments, and 150 reviews.`);

    // 5. Seed CANCELLED Trips (15 trips)
    for (let c = 1; c <= 15; c++) {
      const rider = riders[(c + 2) % riders.length];
      const loc = locations[c % locations.length];
      const reqTime = new Date(SEED_EPOCH.getTime() - c * 7200000);
      const cancelTime = new Date(reqTime.getTime() + 300000);

      await client.query(`
        INSERT INTO trips (
          id, rider_id, pickup_latitude, pickup_longitude, pickup_address,
          destination_latitude, destination_longitude, destination_address,
          status, fare_amount_minor, currency,
          requested_at, cancelled_at, cancellation_reason
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8,
          'CANCELLED', 300000, 'NGN',
          $9, $10, 'Rider changed travel plans'
        );
      `, [
        ID.trip(TRIP.cancelled(c)),
        rider.id, loc.pLat, loc.pLng, loc.pAddr, loc.dLat, loc.dLng, loc.dAddr,
        reqTime.toISOString(), cancelTime.toISOString()
      ]);
    }
    console.log('✓ Seeded 15 CANCELLED trips.');

    // 6. Seed Current Available REQUESTED Trips (Query 2 driver queue)
    // Riders 0, 1, 2 have active trips. Let's give rider 4, 5, 6, 7 REQUESTED trips
    const requestedTripsData = [
      { rider: riders[4], pAddr: 'Maryland Mall, Ikorodu Road', dAddr: 'Civic Centre, Ozumba Mbadiwe, VI', fare: 420000, minsAgo: 2 },
      { rider: riders[5], pAddr: 'Palms Shopping Mall, Lekki', dAddr: 'Landmark Beach, Oniru', fare: 250000, minsAgo: 5 },
      { rider: riders[6], pAddr: 'Opebi Road, Salvation Bus Stop', dAddr: 'Murtala Muhammed Airport Terminal 1', fare: 380000, minsAgo: 8 },
      { rider: riders[7], pAddr: 'Lekki Conservation Centre', dAddr: 'Novare Mall, Sangotedo', fare: 490000, minsAgo: 11 },
      { rider: riders[8], pAddr: 'Unilag Main Gate, Akoka', dAddr: 'Silverbird Galleria, Ahmadu Bello Way', fare: 360000, minsAgo: 14 }
    ];

    for (const [k, rt] of requestedTripsData.entries()) {
      const reqAt = new Date(SEED_EPOCH.getTime() - rt.minsAgo * 60000);
      await client.query(`
        INSERT INTO trips (
          id, rider_id, pickup_latitude, pickup_longitude, pickup_address,
          destination_latitude, destination_longitude, destination_address,
          status, fare_amount_minor, currency, requested_at
        ) VALUES (
          $1, $2, 6.5500, 3.3600, $3, 6.4400, 3.4200, $4,
          'REQUESTED', $5, 'NGN', $6
        );
      `, [ID.trip(TRIP.requested(k + 1)), rt.rider.id, rt.pAddr, rt.dAddr, rt.fare, reqAt.toISOString()]);
    }
    console.log(`✓ Seeded ${requestedTripsData.length} available REQUESTED trips.`);

    // 7. Seed Active ACCEPTED Trip
    // Rider 0, Driver 2
    const driver2 = drivers[2];
    const vehicle2 = driverVehicleMap.get(driver2.id)!;
    const reqAcceptedAt = new Date(SEED_EPOCH.getTime() - 10 * 60000);
    const accAt = new Date(SEED_EPOCH.getTime() - 8 * 60000);
    await client.query(`
      INSERT INTO trips (
        id, rider_id, driver_id, vehicle_id,
        pickup_latitude, pickup_longitude, pickup_address,
        destination_latitude, destination_longitude, destination_address,
        status, fare_amount_minor, currency,
        driver_name_snapshot, vehicle_description_snapshot,
        requested_at, accepted_at
      ) VALUES (
        $1, $2, $3, $4,
        6.4310, 3.4150, '1004 Estate, Victoria Island',
        6.4480, 3.4800, 'Twinwaters Lagos, Okunde Bluewater Zone',
        'ACCEPTED', 350000, 'NGN',
        $5, $6,
        $7, $8
      );
    `, [
      ID.trip(TRIP.accepted()),
      riders[0].id, driver2.id, vehicle2.id,
      driver2.name, `${vehicle2.make} ${vehicle2.model} (${vehicle2.color}) - ${vehicle2.registration_number}`,
      reqAcceptedAt.toISOString(), accAt.toISOString()
    ]);
    console.log(`✓ Seeded 1 active ACCEPTED trip (Rider: ${riders[0].name}, Driver: ${driver2.name}).`);

    // 8. Seed Active IN_PROGRESS Trip
    // Rider 1, Driver 3
    const driver3 = drivers[3];
    const vehicle3 = driverVehicleMap.get(driver3.id)!;
    const reqProgAt = new Date(SEED_EPOCH.getTime() - 25 * 60000);
    const accProgAt = new Date(SEED_EPOCH.getTime() - 22 * 60000);
    const startProgAt = new Date(SEED_EPOCH.getTime() - 15 * 60000);
    await client.query(`
      INSERT INTO trips (
        id, rider_id, driver_id, vehicle_id,
        pickup_latitude, pickup_longitude, pickup_address,
        destination_latitude, destination_longitude, destination_address,
        status, fare_amount_minor, currency,
        driver_name_snapshot, vehicle_description_snapshot,
        requested_at, accepted_at, started_at
      ) VALUES (
        $1, $2, $3, $4,
        6.5900, 3.3400, 'Sheraton Hotel, Ikeja',
        6.4270, 3.4250, 'Federal Palace Hotel, VI',
        'IN_PROGRESS', 620000, 'NGN',
        $5, $6,
        $7, $8, $9
      );
    `, [
      ID.trip(TRIP.inProgress()),
      riders[1].id, driver3.id, vehicle3.id,
      driver3.name, `${vehicle3.make} ${vehicle3.model} (${vehicle3.color}) - ${vehicle3.registration_number}`,
      reqProgAt.toISOString(), accProgAt.toISOString(), startProgAt.toISOString()
    ]);
    console.log(`✓ Seeded 1 active IN_PROGRESS trip (Rider: ${riders[1].name}, Driver: ${driver3.name}).`);

    await client.query('COMMIT');

    // Run ANALYZE so PostgreSQL cost optimizer has exact distribution statistics
    await client.query('ANALYZE riders;');
    await client.query('ANALYZE drivers;');
    await client.query('ANALYZE vehicles;');
    await client.query('ANALYZE trips;');
    await client.query('ANALYZE payments;');
    await client.query('ANALYZE reviews;');

    console.log('--- [SEED COMPLETE] Database seeded and ANALYZE statistics refreshed. ---');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('--- [SEED FAILED] Error during seeding: ---', err);
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seedDatabase()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
