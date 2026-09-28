-- ============================================================================
-- RideFlow — Deterministic Seed Data (Valid RFC 4122 UUIDs)
-- ============================================================================

-- Clean existing records in reverse dependency order
TRUNCATE TABLE reviews, payments, trips, vehicles, drivers, riders CASCADE;

-- 1. SEED RIDERS
INSERT INTO riders (id, name, email, phone, created_at) VALUES
('11111111-1111-4111-a111-111111111111', 'Alice Johnson', 'alice.johnson@example.com', '+14155550101', '2026-09-01T08:00:00Z'),
('22222222-2222-4222-a222-222222222222', 'Bob Smith',     'bob.smith@example.com',     '+14155550102', '2026-09-02T09:00:00Z'),
('33333333-3333-4333-a333-333333333333', 'Charlie Brown', 'charlie.b@example.com',     '+14155550103', '2026-09-03T10:00:00Z'),
('44444444-4444-4444-a444-444444444444', 'Diana Prince',  'diana.p@example.com',      '+14155550104', '2026-09-04T11:00:00Z');

-- 2. SEED DRIVERS
INSERT INTO drivers (id, name, email, phone, license_number, created_at) VALUES
('da111111-1111-4111-b111-111111111111', 'David Miller', 'david.miller@example.com', '+14155550201', 'DL-CA-9928192', '2026-08-15T08:00:00Z'),
('da222222-2222-4222-b222-222222222222', 'Emma Watson',  'emma.watson@example.com',  '+14155550202', 'DL-CA-8837194', '2026-08-20T08:00:00Z'),
('da333333-3333-4333-b333-333333333333', 'Frank Castle', 'frank.castle@example.com', '+14155550203', 'DL-CA-7746195', '2026-08-25T08:00:00Z');

-- 3. SEED VEHICLES
INSERT INTO vehicles (id, driver_id, registration_number, make, model, year, created_at) VALUES
('ba111111-1111-4111-c111-111111111111', 'da111111-1111-4111-b111-111111111111', '7XYZ890', 'Toyota', 'Camry', 2022, '2026-08-15T09:00:00Z'),
('ba222222-2222-4222-c222-222222222222', 'da222222-2222-4222-b222-222222222222', '6ABC123', 'Honda',  'Civic', 2023, '2026-08-20T09:00:00Z'),
('ba333333-3333-4333-c333-333333333333', 'da333333-3333-4333-b333-333333333333', '8DEF456', 'Tesla',  'Model 3', 2024, '2026-08-25T09:00:00Z');

-- 4. SEED TRIPS (Covering all states)

-- Trip 1: Requested (Awaiting driver dispatch) — Rider Diana
INSERT INTO trips (
    id, rider_id, driver_id, vehicle_id,
    pickup_address, destination_address,
    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
    fare_amount_minor, currency, status, requested_at, created_at
) VALUES (
    'ca111111-1111-4111-d111-111111111111',
    '44444444-4444-4444-a444-444444444444', NULL, NULL,
    '500 Howard St, San Francisco, CA', 'Pier 39, San Francisco, CA',
    37.788500, -122.399200, 37.808600, -122.409800,
    1850, 'USD', 'requested', '2026-09-27T19:50:00Z', '2026-09-27T19:50:00Z'
);

-- Trip 2: Accepted (Driver en route to pickup) — Rider Bob, Driver David, Vehicle Camry
INSERT INTO trips (
    id, rider_id, driver_id, vehicle_id,
    pickup_address, destination_address,
    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
    fare_amount_minor, currency, status, requested_at, accepted_at, created_at
) VALUES (
    'ca222222-2222-4222-d222-222222222222',
    '22222222-2222-4222-a222-222222222222',
    'da111111-1111-4111-b111-111111111111',
    'ba111111-1111-4111-c111-111111111111',
    '101 California St, San Francisco, CA', 'Oracle Park, San Francisco, CA',
    37.792800, -122.398000, 37.778600, -122.389300,
    2200, 'USD', 'accepted', '2026-09-27T19:40:00Z', '2026-09-27T19:42:10Z', '2026-09-27T19:40:00Z'
);

-- Trip 3: In Progress (Passenger on board) — Rider Charlie, Driver Emma, Vehicle Civic
INSERT INTO trips (
    id, rider_id, driver_id, vehicle_id,
    pickup_address, destination_address,
    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
    fare_amount_minor, currency, status, requested_at, accepted_at, started_at, created_at
) VALUES (
    'ca333333-3333-4333-d333-333333333333',
    '33333333-3333-4333-a333-333333333333',
    'da222222-2222-4222-b222-222222222222',
    'ba222222-2222-4222-c222-222222222222',
    'Ferry Building, San Francisco, CA', 'Twin Peaks, San Francisco, CA',
    37.795500, -122.393700, 37.754400, -122.447700,
    3450, 'USD', 'in_progress', '2026-09-27T19:20:00Z', '2026-09-27T19:22:00Z', '2026-09-27T19:28:15Z', '2026-09-27T19:20:00Z'
);

-- Trip 4: Completed with Succeeded Payment and Review — Rider Alice, Driver Frank, Vehicle Model 3
INSERT INTO trips (
    id, rider_id, driver_id, vehicle_id,
    pickup_address, destination_address,
    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
    fare_amount_minor, currency, status, requested_at, accepted_at, started_at, completed_at, created_at
) VALUES (
    'ca444444-4444-4444-d444-444444444444',
    '11111111-1111-4111-a111-111111111111',
    'da333333-3333-4333-b333-333333333333',
    'ba333333-3333-4333-c333-333333333333',
    'Civic Center, San Francisco, CA', 'SFO Terminal 2, San Francisco, CA',
    37.779300, -122.419200, 37.618900, -122.375000,
    4200, 'USD', 'completed', '2026-09-27T17:00:00Z', '2026-09-27T17:02:30Z', '2026-09-27T17:08:00Z', '2026-09-27T17:42:00Z', '2026-09-27T17:00:00Z'
);

-- Trip 5: Completed with Succeeded Payment, awaiting review — Rider Alice, Driver David
INSERT INTO trips (
    id, rider_id, driver_id, vehicle_id,
    pickup_address, destination_address,
    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
    fare_amount_minor, currency, status, requested_at, accepted_at, started_at, completed_at, created_at
) VALUES (
    'ca555555-5555-4555-d555-555555555555',
    '11111111-1111-4111-a111-111111111111',
    'da111111-1111-4111-b111-111111111111',
    'ba111111-1111-4111-c111-111111111111',
    'Salesforce Tower, San Francisco, CA', 'Ghirardelli Square, San Francisco, CA',
    37.789700, -122.397200, 37.805900, -122.423000,
    2650, 'USD', 'completed', '2026-09-26T14:00:00Z', '2026-09-26T14:03:00Z', '2026-09-26T14:09:00Z', '2026-09-26T14:32:00Z', '2026-09-26T14:00:00Z'
);

-- Trip 6: Cancelled — Rider Bob, historical cancellation
INSERT INTO trips (
    id, rider_id, driver_id, vehicle_id,
    pickup_address, destination_address,
    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
    fare_amount_minor, currency, status, requested_at, created_at
) VALUES (
    'ca666666-6666-4666-d666-666666666666',
    '22222222-2222-4222-a222-222222222222', NULL, NULL,
    'Union Square, San Francisco, CA', 'Coit Tower, San Francisco, CA',
    37.787900, -122.407400, 37.802400, -122.405800,
    1500, 'USD', 'cancelled', '2026-09-25T11:00:00Z', '2026-09-25T11:00:00Z'
);

-- 5. SEED PAYMENTS
-- Succeeded payment for Trip 4
INSERT INTO payments (
    id, trip_id, amount_minor, currency, status, provider_reference, paid_at, created_at
) VALUES (
    'ea444444-4444-4444-e444-444444444444',
    'ca444444-4444-4444-d444-444444444444',
    4200, 'USD', 'succeeded', 'ch_rideflow_proof_t4', '2026-09-27T17:42:05Z', '2026-09-27T17:42:00Z'
);

-- Succeeded payment for Trip 5
INSERT INTO payments (
    id, trip_id, amount_minor, currency, status, provider_reference, paid_at, created_at
) VALUES (
    'ea555555-5555-4555-e555-555555555555',
    'ca555555-5555-4555-d555-555555555555',
    2650, 'USD', 'succeeded', 'ch_rideflow_proof_t5', '2026-09-26T14:32:05Z', '2026-09-26T14:32:00Z'
);

-- 6. SEED REVIEWS
-- 5-star review for completed Trip 4
INSERT INTO reviews (
    id, trip_id, rating, comment, created_at
) VALUES (
    'fa444444-4444-4444-f444-444444444444',
    'ca444444-4444-4444-d444-444444444444',
    5, 'Exceptional ride! Driver arrived quickly and the Tesla was spotless.', '2026-09-27T17:50:00Z'
);
