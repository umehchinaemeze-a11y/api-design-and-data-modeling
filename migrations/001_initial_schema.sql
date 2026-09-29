-- ============================================================================
-- Migration: 001_initial_schema.sql
-- Product: UrbanGlide Ride-Hailing Platform
-- Description: Complete production schema including enums, tables, check
--              constraints, partial unique indexes, foreign keys, and triggers.
-- ============================================================================

-- Clean slate execution for idempotent setup
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Drop existing triggers and functions if existing.
-- IF EXISTS only suppresses a missing *trigger*; it still errors when the
-- target relation does not exist at all, which is the case on a brand new
-- database. Guard on to_regclass so this migration runs on an empty instance.
DO $$
BEGIN
  IF to_regclass('public.trips') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_enforce_trip_status_transition ON trips;
  END IF;
  IF to_regclass('public.reviews') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_enforce_review_completion ON reviews;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS enforce_trip_status_transition();
DROP FUNCTION IF EXISTS enforce_review_completion();

-- Drop existing tables in reverse dependency order
DROP TABLE IF EXISTS reviews CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS trips CASCADE;
DROP TABLE IF EXISTS vehicles CASCADE;
DROP TABLE IF EXISTS drivers CASCADE;
DROP TABLE IF EXISTS riders CASCADE;

-- Drop enums if existing
DROP TYPE IF EXISTS payment_status_enum CASCADE;
DROP TYPE IF EXISTS trip_status_enum CASCADE;
DROP TYPE IF EXISTS vehicle_type_enum CASCADE;
DROP TYPE IF EXISTS driver_status_enum CASCADE;

-- ============================================================================
-- ENUM TYPES
-- ============================================================================

CREATE TYPE driver_status_enum AS ENUM (
  'OFFLINE',
  'AVAILABLE',
  'ON_TRIP',
  'SUSPENDED'
);

CREATE TYPE vehicle_type_enum AS ENUM (
  'STANDARD',
  'COMFORT',
  'XL',
  'PREMIUM'
);

CREATE TYPE trip_status_enum AS ENUM (
  'REQUESTED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE payment_status_enum AS ENUM (
  'PENDING',
  'COMPLETED',
  'FAILED',
  'REFUNDED'
);

-- ============================================================================
-- TABLE: riders
-- ============================================================================
CREATE TABLE riders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(30) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

-- ============================================================================
-- TABLE: drivers
-- ============================================================================
CREATE TABLE drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(30) NOT NULL UNIQUE,
  license_number VARCHAR(50) NOT NULL UNIQUE,
  status driver_status_enum NOT NULL DEFAULT 'OFFLINE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

-- ============================================================================
-- TABLE: vehicles
-- ============================================================================
CREATE TABLE vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  registration_number VARCHAR(20) NOT NULL UNIQUE,
  make VARCHAR(50) NOT NULL,
  model VARCHAR(50) NOT NULL,
  year INT NOT NULL CHECK (year >= 2005 AND year <= 2030),
  color VARCHAR(30) NOT NULL,
  vehicle_type vehicle_type_enum NOT NULL DEFAULT 'STANDARD',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

-- Invariant: A driver may register multiple vehicles, but at most ONE can be active for dispatch
CREATE UNIQUE INDEX idx_vehicles_driver_single_active 
ON vehicles (driver_id) 
WHERE is_active = TRUE AND deleted_at IS NULL;

-- ============================================================================
-- TABLE: trips
-- ============================================================================
CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id UUID NOT NULL REFERENCES riders(id) ON DELETE RESTRICT,
  driver_id UUID NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  vehicle_id UUID NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
  pickup_latitude NUMERIC(9,6) NOT NULL CHECK (pickup_latitude BETWEEN -90.0 AND 90.0),
  pickup_longitude NUMERIC(9,6) NOT NULL CHECK (pickup_longitude BETWEEN -180.0 AND 180.0),
  pickup_address VARCHAR(255) NOT NULL,
  destination_latitude NUMERIC(9,6) NOT NULL CHECK (destination_latitude BETWEEN -90.0 AND 90.0),
  destination_longitude NUMERIC(9,6) NOT NULL CHECK (destination_longitude BETWEEN -180.0 AND 180.0),
  destination_address VARCHAR(255) NOT NULL,
  status trip_status_enum NOT NULL DEFAULT 'REQUESTED',
  fare_amount_minor BIGINT NOT NULL CHECK (fare_amount_minor > 0),
  currency VARCHAR(3) NOT NULL CHECK (length(currency) = 3),
  
  -- Deliberate historical snapshots
  driver_name_snapshot VARCHAR(100) NULL,
  vehicle_description_snapshot VARCHAR(150) NULL,
  
  -- Lifecycle timestamps
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ NULL,
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  cancellation_reason VARCHAR(255) NULL,
  
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Structural Invariants
  CONSTRAINT chk_trips_driver_assignment CHECK (
    (status = 'REQUESTED') OR 
    (status IN ('ACCEPTED', 'IN_PROGRESS', 'COMPLETED') AND driver_id IS NOT NULL AND vehicle_id IS NOT NULL) OR
    (status = 'CANCELLED')
  ),
  CONSTRAINT chk_trips_timestamps CHECK (
    (status != 'ACCEPTED' OR accepted_at IS NOT NULL) AND
    (status != 'IN_PROGRESS' OR started_at IS NOT NULL) AND
    (status != 'COMPLETED' OR completed_at IS NOT NULL) AND
    (status != 'CANCELLED' OR cancelled_at IS NOT NULL)
  )
);

-- Invariant 1: A rider can have AT MOST ONE active trip ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS')
CREATE UNIQUE INDEX idx_trips_single_active_rider 
ON trips (rider_id) 
WHERE status IN ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS');

-- Invariant 2: A driver can be assigned to AT MOST ONE active trip ('ACCEPTED', 'IN_PROGRESS')
CREATE UNIQUE INDEX idx_trips_single_active_driver 
ON trips (driver_id) 
WHERE status IN ('ACCEPTED', 'IN_PROGRESS');

-- Performance Index: Driver available trips queue (Query 2)
-- Covers pending unassigned ride requests sorted chronologically
CREATE INDEX idx_trips_driver_available_queue 
ON trips (requested_at DESC) 
WHERE status = 'REQUESTED' AND driver_id IS NULL;

-- Performance Index: Rider completed trips history (Query 4)
CREATE INDEX idx_trips_rider_completed 
ON trips (rider_id, completed_at DESC) 
WHERE status = 'COMPLETED';

-- Performance Index: Foreign key lookup for driver trip history
CREATE INDEX idx_trips_driver_id 
ON trips (driver_id);

-- ============================================================================
-- TABLE: payments
-- ============================================================================
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL UNIQUE REFERENCES trips(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency VARCHAR(3) NOT NULL CHECK (length(currency) = 3),
  status payment_status_enum NOT NULL DEFAULT 'PENDING',
  provider_reference VARCHAR(100) NOT NULL UNIQUE,
  payment_method VARCHAR(50) NOT NULL DEFAULT 'CARD',
  paid_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- TABLE: reviews
-- ============================================================================
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL UNIQUE REFERENCES trips(id) ON DELETE RESTRICT,
  rider_id UUID NOT NULL REFERENCES riders(id) ON DELETE RESTRICT,
  driver_id UUID NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
  comment TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance Index: Driver ratings and recent reviews (Query 5)
CREATE INDEX idx_reviews_driver_created 
ON reviews (driver_id, created_at DESC);

-- ============================================================================
-- DATABASE TRIGGERS FOR LIFECYCLE & INVARIANT ENFORCEMENT
-- ============================================================================

-- Function: enforce_trip_status_transition
-- Prevents illegal state transitions at the database engine level
CREATE OR REPLACE FUNCTION enforce_trip_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- If status did not change, permit update
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  -- Terminal states cannot transition to anything
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'Invalid trip state transition: COMPLETED trips cannot transition to %', NEW.status
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'Invalid trip state transition: CANCELLED trips cannot transition to %', NEW.status
      USING ERRCODE = '23514';
  END IF;

  -- Valid forward transitions
  IF OLD.status = 'REQUESTED' AND NEW.status IN ('ACCEPTED', 'CANCELLED') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'ACCEPTED' AND NEW.status IN ('IN_PROGRESS', 'CANCELLED') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'IN_PROGRESS' AND NEW.status IN ('COMPLETED', 'CANCELLED') THEN
    RETURN NEW;
  END IF;

  -- Any other jump (e.g. REQUESTED -> COMPLETED, IN_PROGRESS -> ACCEPTED) is forbidden
  RAISE EXCEPTION 'Invalid trip state transition: % to % is forbidden', OLD.status, NEW.status
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_trip_status_transition
BEFORE UPDATE OF status ON trips
FOR EACH ROW
EXECUTE FUNCTION enforce_trip_status_transition();


-- Function: enforce_review_completion
-- Guarantees that reviews are only submitted for COMPLETED trips,
-- and verifies rider and driver match the trip record.
CREATE OR REPLACE FUNCTION enforce_review_completion()
RETURNS TRIGGER AS $$
DECLARE
  v_trip_status trip_status_enum;
  v_rider_id UUID;
  v_driver_id UUID;
BEGIN
  SELECT status, rider_id, driver_id
  INTO v_trip_status, v_rider_id, v_driver_id
  FROM trips
  WHERE id = NEW.trip_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot review non-existent trip %', NEW.trip_id
      USING ERRCODE = '23503'; -- foreign_key_violation
  END IF;

  IF v_trip_status != 'COMPLETED' THEN
    RAISE EXCEPTION 'Reviews are only permitted for COMPLETED trips. Current status of trip % is %', NEW.trip_id, v_trip_status
      USING ERRCODE = '23514'; -- check_violation
  END IF;

  IF NEW.rider_id != v_rider_id THEN
    RAISE EXCEPTION 'Review rider_id % does not match trip rider_id %', NEW.rider_id, v_rider_id
      USING ERRCODE = '23514';
  END IF;

  IF NEW.driver_id != v_driver_id THEN
    RAISE EXCEPTION 'Review driver_id % does not match trip driver_id %', NEW.driver_id, v_driver_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enforce_review_completion
BEFORE INSERT ON reviews
FOR EACH ROW
EXECUTE FUNCTION enforce_review_completion();
