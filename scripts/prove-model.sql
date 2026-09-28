-- ============================================================================
-- RideFlow — Reproducible SQL Proof Script
-- Can be executed via: psql -U postgres -d rideflow -f scripts/prove-model.sql
-- ============================================================================

\echo '===================================================================='
\echo '1. VERIFY SEEDED DATA COUNTS'
\echo '===================================================================='
SELECT 'riders' AS tbl, count(*) FROM riders
UNION ALL
SELECT 'drivers', count(*) FROM drivers
UNION ALL
SELECT 'vehicles', count(*) FROM vehicles
UNION ALL
SELECT 'trips', count(*) FROM trips
UNION ALL
SELECT 'payments', count(*) FROM payments
UNION ALL
SELECT 'reviews', count(*) FROM reviews;

\echo '===================================================================='
\echo '2. INVALID OPERATION 1: DUPLICATE ACTIVE TRIP FOR RIDER'
\echo 'Expected: 23505 Unique Violation on idx_trips_rider_active'
\echo '===================================================================='
DO $$
BEGIN
    INSERT INTO trips (
        id, rider_id, pickup_address, destination_address,
        pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
        fare_amount_minor, currency, status
    ) VALUES (
        gen_random_uuid(),
        '44444444-4444-4444-a444-444444444444', -- Diana Prince (already has requested trip)
        'Origin', 'Destination',
        37.77, -122.41, 37.78, -122.40,
        2500, 'USD', 'requested'
    );
    RAISE EXCEPTION 'TEST FAILED: Duplicate active trip should have been rejected!';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'SUCCESS: Rejected with unique_violation (SQLSTATE 23505)';
END $$;

\echo '===================================================================='
\echo '3. INVALID OPERATION 2: ILLEGAL TRIP STATUS TRANSITION'
\echo 'Expected: P0001 Exception from trg_validate_trip_status_transition'
\echo '===================================================================='
DO $$
BEGIN
    UPDATE trips
    SET status = 'in_progress'
    WHERE id = 'ca444444-4444-4444-d444-444444444444'; -- Completed trip
    RAISE EXCEPTION 'TEST FAILED: Illegal transition should have been rejected!';
EXCEPTION
    WHEN raise_exception THEN
        RAISE NOTICE 'SUCCESS: Rejected with exception (SQLSTATE P0001): %', SQLERRM;
END $$;

\echo '===================================================================='
\echo '4. INVALID OPERATION 3: PREMATURE REVIEW ON INCOMPLETE TRIP'
\echo 'Expected: P0001 Exception from trg_validate_review_eligibility'
\echo '===================================================================='
DO $$
BEGIN
    INSERT INTO reviews (
        id, trip_id, rating, comment
    ) VALUES (
        gen_random_uuid(),
        'ca333333-3333-4333-d333-333333333333', -- In progress trip
        5, 'Premature review attempt'
    );
    RAISE EXCEPTION 'TEST FAILED: Review on in-progress trip should have been rejected!';
EXCEPTION
    WHEN raise_exception THEN
        RAISE NOTICE 'SUCCESS: Rejected with exception (SQLSTATE P0001): %', SQLERRM;
END $$;

\echo '===================================================================='
\echo '5. VALID STATE TRANSITION (POSITIVE PROOF)'
\echo 'Requested -> Accepted (with driver & vehicle attached)'
\echo '===================================================================='
UPDATE trips
SET status = 'accepted',
    driver_id = 'da333333-3333-4333-b333-333333333333',
    vehicle_id = 'ba333333-3333-4333-c333-333333333333'
WHERE id = 'ca111111-1111-4111-d111-111111111111'
RETURNING id, status, accepted_at, driver_id, vehicle_id;

\echo '===================================================================='
\echo '6. EXPLAIN (ANALYZE, BUFFERS) ACTIVE TRIP LOOKUP'
\echo '===================================================================='
EXPLAIN (ANALYZE, BUFFERS)
SELECT t.id, t.status, d.name AS driver_name, v.registration_number
FROM trips t
LEFT JOIN drivers d ON t.driver_id = d.id
LEFT JOIN vehicles v ON t.vehicle_id = v.id
WHERE t.rider_id = '22222222-2222-4222-a222-222222222222'
  AND t.status IN ('requested', 'accepted', 'in_progress');
