const { Client } = require('pg');
const { provision, TARGET } = require('./lib/provision');

/*
 * Automated QA suite for the canonical UrbanGlide data model.
 *
 * This runs against the same database described in README section 27
 * (docker-compose service `urban-glide-postgres`, database `urbanglide_db`) and
 * the same schema file as every proof in evidence/: migrations/001_initial_schema.sql.
 * Constraint names and SQLSTATEs below are quoted from that migration verbatim.
 */

/* Deterministic fixtures produced by src/seed.ts. */
const ID = {
    rider: (n) => `11111111-1111-4111-a111-${String(n).padStart(12, '0')}`,
    driver: (n) => `22222222-2222-4222-a222-${String(n).padStart(12, '0')}`,
    vehicle: (n) => `33333333-3333-4333-a333-${String(n).padStart(12, '0')}`,
    trip: (n) => `44444444-4444-4444-a444-${String(n).padStart(12, '0')}`,
};

const UNKNOWN_RIDER = '00000000-0000-0000-0000-000000000000';

async function runTestSuite() {
    const client = new Client({ connectionString: TARGET.connectionString });

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
        console.log('================================================================');
        console.log('        URBANGLIDE AUTOMATED DATA MODEL QA TEST SUITE         ');
        console.log('================================================================\n');

        // Reset to the canonical schema + canonical deterministic dataset
        await provision();

        await client.connect();

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
            SELECT typname FROM pg_type WHERE typname IN ('trip_status_enum', 'payment_status_enum');
        `);
        assert(enumsRes.rows.length === 2, 'Required ENUM types exist in PostgreSQL');

        const triggersRes = await client.query(`
            SELECT tgname FROM pg_trigger
            WHERE tgname IN ('trg_enforce_trip_status_transition', 'trg_enforce_review_completion', 'trg_enforce_payment_completion')
              AND NOT tgisinternal;
        `);
        assert(triggersRes.rows.length === 3, 'All three lifecycle-enforcement triggers exist in the catalog');

        // 2. REFERENTIAL INTEGRITY
        console.log('\nSUITE 2: Foreign Key & Referential Integrity');
        try {
            await client.query(`
                INSERT INTO trips (
                    rider_id, pickup_address, destination_address,
                    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
                    fare_amount_minor, currency, status
                ) VALUES (
                    '${UNKNOWN_RIDER}',
                    'A', 'B', 6.4281, 3.4219, 6.4500, 3.4000,
                    1000, 'NGN', 'REQUESTED'
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
                    '${ID.rider(3)}',
                    'A', 'B', 6.4281, 3.4219, 6.4500, 3.4000,
                    -500, 'NGN', 'REQUESTED'
                );
            `);
            assert(false, 'Negative fare rejected', 'Allowed negative fare amount');
        } catch (err) {
            assert(err.code === '23514' && /fare_amount_minor/.test(err.message),
                'Negative fare rejected with CHECK constraint 23514 on fare_amount_minor', err.message);
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
                    '${ID.rider(5)}', -- Folake Adebayo already holds REQUESTED trip 216
                    'A', 'B', 6.4281, 3.4219, 6.4500, 3.4000,
                    2000, 'NGN', 'REQUESTED'
                );
            `);
            assert(false, 'Second active trip rejected', 'Allowed concurrent active trip');
        } catch (err) {
            assert(err.code === '23505' && err.constraint === 'idx_trips_single_active_rider',
                'Second active trip rejected with 23505 on idx_trips_single_active_rider', err.message);
        }

        // 5. STATE MACHINE TRIGGER ENFORCEMENT
        console.log('\nSUITE 5: Lifecycle State Machine Transitions');

        // Valid transition: REQUESTED -> ACCEPTED (trip 216 is REQUESTED in the seed)
        const validTransRes = await client.query(`
            UPDATE trips
            SET status = 'ACCEPTED',
                driver_id = '${ID.driver(1)}',
                vehicle_id = '${ID.vehicle(1)}',
                accepted_at = NOW()
            WHERE id = '${ID.trip(216)}'
            RETURNING status, accepted_at;
        `);
        assert(validTransRes.rows[0].status === 'ACCEPTED' && validTransRes.rows[0].accepted_at !== null,
            'Legal transition (REQUESTED -> ACCEPTED) succeeds and sets accepted_at');

        // Invalid transition: COMPLETED -> IN_PROGRESS (terminal state)
        try {
            await client.query(`
                UPDATE trips
                SET status = 'IN_PROGRESS'
                WHERE id = '${ID.trip(1)}';
            `);
            assert(false, 'Illegal transition rejected', 'Allowed COMPLETED -> IN_PROGRESS');
        } catch (err) {
            assert(err.code === '23514' && /Invalid trip state transition/.test(err.message),
                'Illegal transition rejected with trigger SQLSTATE 23514 (trg_enforce_trip_status_transition)', err.message);
        }

        // Invalid: ACCEPTED without driver and vehicle (structural check)
        try {
            await client.query(`
                UPDATE trips
                SET status = 'ACCEPTED', accepted_at = NOW()
                WHERE id = '${ID.trip(217)}';
            `);
            assert(false, 'Incomplete acceptance rejected', 'Allowed ACCEPTED status without driver/vehicle');
        } catch (err) {
            assert(err.code === '23514' && err.constraint === 'chk_trips_driver_assignment',
                'Acceptance without driver/vehicle rejected with chk_trips_driver_assignment (23514)', err.message);
        }

        // 6. REVIEW INTEGRITY
        console.log('\nSUITE 6: Review Integrity & Eligibility');

        // Invalid: review on an incomplete trip (trip 222 is IN_PROGRESS)
        try {
            await client.query(`
                INSERT INTO reviews (trip_id, rider_id, driver_id, rating, comment)
                VALUES ('${ID.trip(222)}', '${ID.rider(2)}', '${ID.driver(4)}', 5, 'Early review');
            `);
            assert(false, 'Ineligible review rejected', 'Allowed review on in-progress trip');
        } catch (err) {
            assert(err.code === '23514' && /only permitted for COMPLETED trips/.test(err.message),
                'Review on incomplete trip rejected with trigger 23514 (trg_enforce_review_completion)', err.message);
        }

        // Invalid: rating out of bounds on a completed trip (trip 1)
        try {
            await client.query(`
                INSERT INTO reviews (trip_id, rider_id, driver_id, rating, comment)
                VALUES ('${ID.trip(1)}', '${ID.rider(2)}', '${ID.driver(2)}', 6, 'Invalid 6 rating');
            `);
            assert(false, 'Rating > 5 rejected', 'Allowed rating 6');
        } catch (err) {
            assert(err.code === '23514' && err.constraint === 'reviews_rating_check',
                'Rating > 5 rejected with CHECK constraint reviews_rating_check (23514)', err.message);
        }

        // Valid: review on a completed trip that has none yet (trip 4 is completed, unreviewed)
        const validRevRes = await client.query(`
            INSERT INTO reviews (trip_id, rider_id, driver_id, rating, comment)
            VALUES ('${ID.trip(4)}', '${ID.rider(5)}', '${ID.driver(5)}', 5, 'Five stars!')
            RETURNING id, rating;
        `);
        assert(validRevRes.rows[0].rating === 5, 'Review on completed trip succeeds');

        // Duplicate review on the same trip is rejected
        try {
            await client.query(`
                INSERT INTO reviews (trip_id, rider_id, driver_id, rating, comment)
                VALUES ('${ID.trip(4)}', '${ID.rider(5)}', '${ID.driver(5)}', 4, 'Duplicate review');
            `);
            assert(false, 'Duplicate review rejected', 'Allowed second review on same trip');
        } catch (err) {
            assert(err.code === '23505' && err.constraint === 'reviews_trip_id_key',
                'Duplicate review rejected with UNIQUE violation 23505 on reviews_trip_id_key', err.message);
        }

        // 7. SOFT DELETION & HISTORICAL RETENTION
        console.log('\nSUITE 7: Historical Retention & Soft Deletion');

        // Hard deleting a rider with historical trips must fail (ON DELETE RESTRICT)
        try {
            await client.query(`DELETE FROM riders WHERE id = '${ID.rider(1)}';`);
            assert(false, 'Hard delete cascade prevented', 'Deleted rider with active/historical trips');
        } catch (err) {
            assert(err.code === '23503',
                'Hard delete of rider with trips blocked by ON DELETE RESTRICT (23503)', err.message);
        }

        // Soft delete succeeds and preserves trip history
        const softDelRes = await client.query(`
            UPDATE riders SET deleted_at = NOW() WHERE id = '${ID.rider(1)}' RETURNING deleted_at;
        `);
        assert(softDelRes.rows[0].deleted_at !== null, 'Soft delete sets deleted_at while preserving trip history');

        // 8. PAYMENT INTEGRITY
        // Mirrors Suite 3 (monetary bounds) and Suite 6 (completion gating) but
        // for the payments table and its dedicated trigger (FR-11).
        console.log('\nSUITE 8: Payment Integrity (amount bounds & completion gate)');

        // Zero-amount payment rejected by the amount_minor > 0 CHECK constraint.
        // Uses the first COMPLETED trip in the seed so the completion-gate trigger
        // does not interfere with observing the CHECK violation.
        try {
            await client.query(`
                INSERT INTO payments (trip_id, amount_minor, currency, status, provider_reference, payment_method)
                VALUES ('${ID.trip(1)}', 0, 'NGN', 'PENDING', 'test_zero_amount_payment', 'CARD');
            `);
            assert(false, 'Zero-amount payment rejected', 'Allowed amount_minor = 0 in payments');
        } catch (err) {
            assert(
                err.code === '23514' && /amount_minor/.test(err.message),
                'Zero-amount payment rejected with CHECK constraint 23514 on amount_minor', err.message
            );
        }

        // Payment on a non-COMPLETED trip rejected by trg_enforce_payment_completion.
        // trip 222 is IN_PROGRESS in the seed — the most representative live status
        // because it is the furthest along without being terminal.
        try {
            await client.query(`
                INSERT INTO payments (trip_id, amount_minor, currency, status, provider_reference, payment_method)
                VALUES ('${ID.trip(222)}', 350000, 'NGN', 'PENDING', 'test_payment_not_completed', 'CARD');
            `);
            assert(false, 'Payment on non-completed trip rejected', 'Allowed payment for IN_PROGRESS trip');
        } catch (err) {
            assert(
                err.code === '23514' && /Payments are only permitted for COMPLETED trips/.test(err.message),
                'Payment on IN_PROGRESS trip rejected with trigger SQLSTATE 23514 (trg_enforce_payment_completion)', err.message
            );
        }

        // Re-pointing an existing payment to a non-COMPLETED trip rejected by the
        // extended trg_enforce_payment_completion (BEFORE INSERT OR UPDATE OF trip_id).
        // The seed gives every COMPLETED trip a payment, so the payment for trip 1 is
        // re-pointed to trip 222 (IN_PROGRESS). Neither payments_trip_id_key (UNIQUE)
        // nor the foreign key blocks this; only the UPDATE arm of the trigger does.
        try {
            await client.query(`
                UPDATE payments
                SET trip_id = '${ID.trip(222)}'
                WHERE trip_id = '${ID.trip(1)}';
            `);
            assert(false, 'Re-pointing payment to non-completed trip rejected', 'Allowed payment trip_id update to IN_PROGRESS trip');
        } catch (err) {
            assert(
                err.code === '23514' && /Payments are only permitted for COMPLETED trips/.test(err.message),
                'Payment re-point to IN_PROGRESS trip rejected with trigger SQLSTATE 23514 (trg_enforce_payment_completion)', err.message
            );
        }

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
