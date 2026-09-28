const { Client } = require('pg');

async function runTestSuite() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:15436/rideflow?sslmode=disable'
    });

    let passed = 0;
    let failed = 0;

    function assert(condition, testName, detail = '') {
        if (condition) {
            console.log(`  [PASS] ${testName}`);
            passed++;
        } else {
            console.error(`  [FAIL] ${testName} - ${detail}`);
            failed++;
        }
    }

    try {
        await client.connect();
        console.log('================================================================');
        console.log('             RIDEFLOW AUTOMATED QA TEST SUITE                   ');
        console.log('================================================================\n');

        // Reset database to clean seeded state before tests
        const fs = require('fs');
        const path = require('path');
        const seedSql = fs.readFileSync(path.join(__dirname, '../sql/seed.sql'), 'utf8');
        await client.query(seedSql);

        // 1. SCHEMA INTEGRITY
        console.log('SUITE 1: Schema & Object Verification');
        const tablesRes = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
              AND table_name IN ('riders', 'drivers', 'vehicles', 'trips', 'payments', 'reviews');
        `);
        assert(tablesRes.rows.length === 6, 'All 6 core relational tables exist');

        const enumsRes = await client.query(`
            SELECT typname FROM pg_type WHERE typname IN ('trip_status', 'payment_status');
        `);
        assert(enumsRes.rows.length === 2, 'Required ENUM types exist in PostgreSQL');

        // 2. REFERENTIAL INTEGRITY
        console.log('\nSUITE 2: Foreign Key & Referential Integrity');
        try {
            await client.query(`
                INSERT INTO trips (
                    rider_id, pickup_address, destination_address,
                    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
                    fare_amount_minor, currency, status
                ) VALUES (
                    '00000000-0000-0000-0000-000000000000', -- Non-existent rider
                    'A', 'B', 37.77, -122.41, 37.78, -122.40,
                    1000, 'USD', 'requested'
                );
            `);
            assert(false, 'Orphan trip rejected', 'Allowed non-existent rider_id');
        } catch (err) {
            assert(err.code === '23503', 'Foreign key violation rejected with 23503', err.message);
        }

        // 3. MONETARY CHECK CONSTRAINTS
        console.log('\nSUITE 3: Monetary Safety (Minor Units & Positive Bounds)');
        try {
            await client.query(`
                INSERT INTO trips (
                    rider_id, pickup_address, destination_address,
                    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
                    fare_amount_minor, currency, status
                ) VALUES (
                    '11111111-1111-4111-a111-111111111111',
                    'A', 'B', 37.77, -122.41, 37.78, -122.40,
                    -500, 'USD', 'cancelled'
                );
            `);
            assert(false, 'Negative fare rejected', 'Allowed negative fare amount');
        } catch (err) {
            assert(err.code === '23514', 'Negative fare rejected with CHECK constraint 23514', err.message);
        }

        // 4. ACTIVE TRIP PARTIAL UNIQUE INDEX
        console.log('\nSUITE 4: Active Trip Invariant');
        try {
            await client.query(`
                INSERT INTO trips (
                    rider_id, pickup_address, destination_address,
                    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
                    fare_amount_minor, currency, status
                ) VALUES (
                    '44444444-4444-4444-a444-444444444444', -- Diana (already has requested trip)
                    'A', 'B', 37.77, -122.41, 37.78, -122.40,
                    2000, 'USD', 'requested'
                );
            `);
            assert(false, 'Second active trip rejected', 'Allowed concurrent active trip');
        } catch (err) {
            assert(err.code === '23505' && err.constraint === 'idx_trips_rider_active',
                'Second active trip rejected with 23505 on idx_trips_rider_active', err.message);
        }

        // 5. STATE MACHINE TRIGGER ENFORCEMENT
        console.log('\nSUITE 5: Lifecycle State Machine Transitions');
        // Valid transition: requested -> accepted
        const validTransRes = await client.query(`
            UPDATE trips
            SET status = 'accepted',
                driver_id = 'da333333-3333-4333-b333-333333333333',
                vehicle_id = 'ba333333-3333-4333-c333-333333333333'
            WHERE id = 'ca111111-1111-4111-d111-111111111111'
            RETURNING status, accepted_at;
        `);
        assert(validTransRes.rows[0].status === 'accepted' && validTransRes.rows[0].accepted_at !== null,
            'Legal transition (requested -> accepted) succeeds and sets accepted_at');

        // Invalid transition: completed -> in_progress
        try {
            await client.query(`
                UPDATE trips
                SET status = 'in_progress'
                WHERE id = 'ca444444-4444-4444-d444-444444444444';
            `);
            assert(false, 'Illegal transition rejected', 'Allowed completed -> in_progress');
        } catch (err) {
            assert(err.code === 'P0001', 'Illegal transition rejected with trigger P0001', err.message);
        }

        // Invalid transition: accepted without driver and vehicle
        try {
            await client.query(`
                UPDATE trips
                SET status = 'accepted'
                WHERE id = 'ca666666-6666-4666-d666-666666666666';
            `);
            assert(false, 'Incomplete acceptance rejected', 'Allowed accepted status without driver/vehicle');
        } catch (err) {
            assert(err.code === 'P0001', 'Acceptance without driver/vehicle rejected with P0001', err.message);
        }

        // 6. REVIEW INTEGRITY
        console.log('\nSUITE 6: Review Integrity & Eligibility');
        // Invalid: review on incomplete trip
        try {
            await client.query(`
                INSERT INTO reviews (trip_id, rating, comment)
                VALUES ('ca333333-3333-4333-d333-333333333333', 5, 'Early review');
            `);
            assert(false, 'Ineligible review rejected', 'Allowed review on in-progress trip');
        } catch (err) {
            assert(err.code === 'P0001', 'Review on incomplete trip rejected with trigger P0001', err.message);
        }

        // Invalid: rating out of bounds
        try {
            await client.query(`
                INSERT INTO reviews (trip_id, rating, comment)
                VALUES ('ca555555-5555-4555-d555-555555555555', 6, 'Invalid 6 rating');
            `);
            assert(false, 'Rating > 5 rejected', 'Allowed rating 6');
        } catch (err) {
            assert(err.code === '23514', 'Rating > 5 rejected with CHECK constraint 23514', err.message);
        }

        // Valid: review on completed trip
        const validRevRes = await client.query(`
            INSERT INTO reviews (trip_id, rating, comment)
            VALUES ('ca555555-5555-4555-d555-555555555555', 5, 'Five stars!')
            RETURNING id, rating;
        `);
        assert(validRevRes.rows[0].rating === 5, 'Review on completed trip succeeds');

        // Duplicate review on same trip rejected
        try {
            await client.query(`
                INSERT INTO reviews (trip_id, rating, comment)
                VALUES ('ca555555-5555-4555-d555-555555555555', 4, 'Duplicate review');
            `);
            assert(false, 'Duplicate review rejected', 'Allowed second review on same trip');
        } catch (err) {
            assert(err.code === '23505', 'Duplicate review rejected with UNIQUE violation 23505', err.message);
        }

        // 7. SOFT DELETION & HISTORICAL RETENTION
        console.log('\nSUITE 7: Historical Retention & Soft Deletion');
        // Attempting to HARD DELETE a rider with historical trips must fail due to ON DELETE RESTRICT
        try {
            await client.query(`DELETE FROM riders WHERE id = '11111111-1111-4111-a111-111111111111';`);
            assert(false, 'Hard delete cascade prevented', 'Deleted rider with active/historical trips');
        } catch (err) {
            assert(err.code === '23503', 'Hard delete of rider with trips blocked by ON DELETE RESTRICT (23503)', err.message);
        }

        // Soft delete succeeds
        const softDelRes = await client.query(`
            UPDATE riders SET deleted_at = NOW() WHERE id = '11111111-1111-4111-a111-111111111111' RETURNING deleted_at;
        `);
        assert(softDelRes.rows[0].deleted_at !== null, 'Soft delete sets deleted_at while preserving trip history');

        console.log('\n================================================================');
        console.log(`TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
        console.log('================================================================\n');

        if (failed > 0) {
            process.exit(1);
        }
    } catch (err) {
        console.error('Test suite failed with unexpected error:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

runTestSuite();
