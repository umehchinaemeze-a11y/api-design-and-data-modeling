-- ============================================================================
-- RideFlow — Database Schema & Data Integrity Migration
-- Engine: PostgreSQL 16+
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. ENUMS
-- ----------------------------------------------------------------------------
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'trip_status') THEN
        CREATE TYPE trip_status AS ENUM (
            'requested',
            'accepted',
            'in_progress',
            'completed',
            'cancelled'
        );
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_status') THEN
        CREATE TYPE payment_status AS ENUM (
            'pending',
            'succeeded',
            'failed'
        );
    END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2. TABLES
-- ----------------------------------------------------------------------------

-- Riders Table
CREATE TABLE IF NOT EXISTS riders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL
);

-- Drivers Table
CREATE TABLE IF NOT EXISTS drivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(32) NOT NULL,
    license_number VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL
);

-- Vehicles Table
CREATE TABLE IF NOT EXISTS vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
    registration_number VARCHAR(30) NOT NULL UNIQUE,
    make VARCHAR(50) NOT NULL,
    model VARCHAR(50) NOT NULL,
    year INTEGER NOT NULL CHECK (year >= 1990 AND year <= 2100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NULL
);

-- Trips Table
CREATE TABLE IF NOT EXISTS trips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id UUID NOT NULL REFERENCES riders(id) ON DELETE RESTRICT,
    driver_id UUID NULL REFERENCES drivers(id) ON DELETE RESTRICT,
    vehicle_id UUID NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
    pickup_address TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    pickup_latitude NUMERIC(9,6) NOT NULL CHECK (pickup_latitude BETWEEN -90.0 AND 90.0),
    pickup_longitude NUMERIC(9,6) NOT NULL CHECK (pickup_longitude BETWEEN -180.0 AND 180.0),
    destination_latitude NUMERIC(9,6) NOT NULL CHECK (destination_latitude BETWEEN -90.0 AND 90.0),
    destination_longitude NUMERIC(9,6) NOT NULL CHECK (destination_longitude BETWEEN -180.0 AND 180.0),
    fare_amount_minor BIGINT NOT NULL CHECK (fare_amount_minor > 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
    status trip_status NOT NULL DEFAULT 'requested',
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at TIMESTAMPTZ NULL,
    started_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payments Table
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id UUID NOT NULL UNIQUE REFERENCES trips(id) ON DELETE RESTRICT,
    amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
    currency VARCHAR(3) NOT NULL CHECK (length(currency) = 3),
    status payment_status NOT NULL DEFAULT 'pending',
    provider_reference VARCHAR(100) NULL UNIQUE,
    paid_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reviews Table
CREATE TABLE IF NOT EXISTS reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id UUID NOT NULL UNIQUE REFERENCES trips(id) ON DELETE RESTRICT,
    rating SMALLINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 3. INDEXES & PARTIAL UNIQUE INVARIANTS
-- ----------------------------------------------------------------------------

-- Soft-delete aware unique indexes for contact identifiers
CREATE UNIQUE INDEX IF NOT EXISTS idx_riders_active_email ON riders (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_riders_active_phone ON riders (phone) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_active_email ON drivers (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_active_phone ON drivers (phone) WHERE deleted_at IS NULL;

-- CRITICAL BUSINESS INVARIANT 1: Rider can have at most ONE active trip
CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_rider_active 
ON trips (rider_id) 
WHERE status IN ('requested', 'accepted', 'in_progress');

-- CRITICAL BUSINESS INVARIANT 2: Driver can have at most ONE active trip
CREATE UNIQUE INDEX IF NOT EXISTS idx_trips_driver_active 
ON trips (driver_id) 
WHERE status IN ('accepted', 'in_progress') AND driver_id IS NOT NULL;

-- High-frequency query pattern: Driver polling for available requested trips
CREATE INDEX IF NOT EXISTS idx_trips_status_requested 
ON trips (requested_at ASC) 
WHERE status = 'requested';

-- High-frequency query pattern: Trip history lookups for riders & drivers
CREATE INDEX IF NOT EXISTS idx_trips_rider_history ON trips (rider_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_driver_history ON trips (driver_id, requested_at DESC) WHERE driver_id IS NOT NULL;

-- Foreign key lookup for vehicle ownership
CREATE INDEX IF NOT EXISTS idx_vehicles_driver_id ON vehicles (driver_id);

-- ----------------------------------------------------------------------------
-- 4. TRIGGERS & PROCEDURES (DATABASE-ENFORCED INVARIANTS)
-- ----------------------------------------------------------------------------

-- A. Generic updated_at trigger
CREATE OR REPLACE FUNCTION trg_fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_riders_updated_at ON riders;
CREATE TRIGGER trg_riders_updated_at BEFORE UPDATE ON riders FOR EACH ROW EXECUTE FUNCTION trg_fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_drivers_updated_at ON drivers;
CREATE TRIGGER trg_drivers_updated_at BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION trg_fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_vehicles_updated_at ON vehicles;
CREATE TRIGGER trg_vehicles_updated_at BEFORE UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION trg_fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_trips_updated_at ON trips;
CREATE TRIGGER trg_trips_updated_at BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION trg_fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_payments_updated_at ON payments;
CREATE TRIGGER trg_payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION trg_fn_set_updated_at();

DROP TRIGGER IF EXISTS trg_reviews_updated_at ON reviews;
CREATE TRIGGER trg_reviews_updated_at BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION trg_fn_set_updated_at();

-- B. Trip State Machine Trigger
CREATE OR REPLACE FUNCTION trg_fn_validate_trip_status_transition()
RETURNS TRIGGER AS $$
BEGIN
    -- No-op if status is unchanged
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    -- requested -> accepted
    IF OLD.status = 'requested' AND NEW.status = 'accepted' THEN
        IF NEW.driver_id IS NULL OR NEW.vehicle_id IS NULL THEN
            RAISE EXCEPTION 'Cannot transition trip to accepted without both driver_id and vehicle_id'
                USING ERRCODE = 'P0001';
        END IF;
        IF NEW.accepted_at IS NULL THEN
            NEW.accepted_at = NOW();
        END IF;
        RETURN NEW;
    END IF;

    -- requested -> cancelled
    IF OLD.status = 'requested' AND NEW.status = 'cancelled' THEN
        RETURN NEW;
    END IF;

    -- accepted -> in_progress
    IF OLD.status = 'accepted' AND NEW.status = 'in_progress' THEN
        IF NEW.started_at IS NULL THEN
            NEW.started_at = NOW();
        END IF;
        RETURN NEW;
    END IF;

    -- accepted -> cancelled
    IF OLD.status = 'accepted' AND NEW.status = 'cancelled' THEN
        RETURN NEW;
    END IF;

    -- in_progress -> completed
    IF OLD.status = 'in_progress' AND NEW.status = 'completed' THEN
        IF NEW.completed_at IS NULL THEN
            NEW.completed_at = NOW();
        END IF;
        RETURN NEW;
    END IF;

    -- in_progress -> cancelled
    IF OLD.status = 'in_progress' AND NEW.status = 'cancelled' THEN
        RETURN NEW;
    END IF;

    -- Any other transition is strictly forbidden
    RAISE EXCEPTION 'Illegal trip status transition from % to %', OLD.status, NEW.status
        USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_trip_status_transition ON trips;
CREATE TRIGGER trg_validate_trip_status_transition
BEFORE UPDATE OF status ON trips
FOR EACH ROW
EXECUTE FUNCTION trg_fn_validate_trip_status_transition();

-- C. Payment State Machine Trigger
CREATE OR REPLACE FUNCTION trg_fn_validate_payment_status_transition()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    -- Succeeded is terminal and immutable
    IF OLD.status = 'succeeded' THEN
        RAISE EXCEPTION 'Cannot alter payment %: status succeeded is immutable', OLD.id
            USING ERRCODE = 'P0001';
    END IF;

    IF OLD.status = 'pending' AND NEW.status IN ('succeeded', 'failed') THEN
        IF NEW.status = 'succeeded' AND NEW.paid_at IS NULL THEN
            NEW.paid_at = NOW();
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status = 'failed' AND NEW.status IN ('pending', 'succeeded') THEN
        IF NEW.status = 'succeeded' AND NEW.paid_at IS NULL THEN
            NEW.paid_at = NOW();
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Illegal payment status transition from % to %', OLD.status, NEW.status
        USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_payment_status_transition ON payments;
CREATE TRIGGER trg_validate_payment_status_transition
BEFORE UPDATE OF status ON payments
FOR EACH ROW
EXECUTE FUNCTION trg_fn_validate_payment_status_transition();

-- D. Review Eligibility Trigger
CREATE OR REPLACE FUNCTION trg_fn_validate_review_eligibility()
RETURNS TRIGGER AS $$
DECLARE
    v_trip_status trip_status;
BEGIN
    SELECT status INTO v_trip_status
    FROM trips
    WHERE id = NEW.trip_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Trip % does not exist', NEW.trip_id
            USING ERRCODE = '23503';
    END IF;

    IF v_trip_status != 'completed' THEN
        RAISE EXCEPTION 'Cannot review trip %: status is %, but only completed trips are eligible for review', 
            NEW.trip_id, v_trip_status
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_review_eligibility ON reviews;
CREATE TRIGGER trg_validate_review_eligibility
BEFORE INSERT ON reviews
FOR EACH ROW
EXECUTE FUNCTION trg_fn_validate_review_eligibility();

-- E. Payment Eligibility Trigger
CREATE OR REPLACE FUNCTION trg_fn_validate_payment_trip_completion()
RETURNS TRIGGER AS $$
DECLARE
    v_trip_status trip_status;
BEGIN
    SELECT status INTO v_trip_status
    FROM trips
    WHERE id = NEW.trip_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Trip % does not exist', NEW.trip_id
            USING ERRCODE = '23503';
    END IF;

    IF v_trip_status != 'completed' THEN
        RAISE EXCEPTION 'Cannot capture payment for trip %: status is %, but only completed trips can be settled',
            NEW.trip_id, v_trip_status
            USING ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_payment_trip_completion ON payments;
CREATE TRIGGER trg_validate_payment_trip_completion
BEFORE INSERT ON payments
FOR EACH ROW
EXECUTE FUNCTION trg_fn_validate_payment_trip_completion();
