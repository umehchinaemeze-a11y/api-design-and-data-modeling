# Product Requirements Document (PRD) — UrbanGlide Ride-Hailing Platform

## 1. Product Overview
**UrbanGlide** is a point-to-point ride-hailing platform connecting riders (passengers needing transit) with licensed drivers operating certified vehicles. The platform governs the lifecycle of ride requests, dispatch acceptance, active transit, fare settlement, and post-trip quality evaluation.

## 2. Core Problem Statement
Urban transportation marketplaces suffer from severe coordination and data-integrity problems:
- **Concurrency Hazards:** Multiple active ride requests by a single passenger or dispatching a driver to conflicting trips causes double-booking, driver churn, and rider frustration.
- **Financial Audit Drift:** Storing recalculable or floating-point fares causes rounding anomalies, disputes with drivers, and accounting divergence across trip records and payment transactions.
- **Premature Quality Signals:** Allowing ratings/reviews before trip completion contaminates reputation scores and invites fraudulent driver collusion.
- **Historical Inaccuracy:** When a driver updates their legal name or a vehicle registration renews, historical trip manifests must not mutate retroactively.

UrbanGlide solves this through a strictly modeled, relationally enforced core engine where critical business invariants are safeguarded at the database tier rather than relying solely on fragile application code.

## 3. Users and Actors
1. **Rider:** An individual requesting transit from a designated pickup point to a destination, tracking active progress, paying for completed trips, and reviewing the experience.
2. **Driver:** A licensed, verified transit operator who toggles availability, accepts dispatched trips, drives riders to destinations, and receives payment disbursements.
3. **Operations & Payment System (System Actor):** Autonomous background/webhook processes handling payment gateway webhooks, fare authorization, capture settlement, and invariant auditing.

*(Note: Full back-office admin dashboards and CRM suites are explicitly out of scope).*

---

## 4. Five Core User Actions
Every architectural entity, constraint, index, API endpoint, and proof query in this system traces directly back to these five foundational user actions:

### Action 1 — Request a Ride
- **Actor:** Rider
- **Description:** A rider specifies pickup coordinates/address and destination coordinates/address. The system creates a trip in `REQUESTED` state with a deterministic upfront agreed fare snapshot.
- **Hard Rule:** A rider cannot request a new trip if they already have an active trip (`REQUESTED`, `ACCEPTED`, or `IN_PROGRESS`).

### Action 2 — Accept and Start a Trip
- **Actor:** Driver
- **Description:** An available driver views pending trip requests in their operational zone, claims an unassigned trip (`ACCEPTED`), and upon arrival and passenger boarding transitions the trip to `IN_PROGRESS`.
- **Hard Rule:** A driver cannot be assigned to more than one active trip at any time. When accepted, the driver’s profile name and vehicle description are snapshotted onto the trip record.

### Action 3 — Track an Active Trip
- **Actor:** Rider
- **Description:** The rider views their current trip status, driver details (snapshotted), vehicle make/model/license plate, current driver trajectory, and ETA.
- **Hard Rule:** Fast, high-concurrency lookups for a rider's single active trip must execute with sub-millisecond index scans.

### Action 4 — Complete and Pay for a Trip
- **Actor:** Driver / Payment Gateway
- **Description:** The driver arrives at the destination and marks the trip `COMPLETED`. The platform captures payment against the rider's payment provider token using the exact immutable fare amount captured at booking.
- **Hard Rule:** A completed trip cannot re-enter `IN_PROGRESS` or `CANCELLED`. Payment must reference the trip uniquely, be denominated in integer minor units, and be strictly idempotent to prevent double billing.

### Action 5 — Review a Completed Trip
- **Actor:** Rider
- **Description:** Upon completion, the rider submits a 1-to-5 star rating and optional feedback for the trip.
- **Hard Rule:** Reviews cannot be created for trips that are in `REQUESTED`, `ACCEPTED`, `IN_PROGRESS`, or `CANCELLED` status. Exactly one review is permitted per trip.

---

## 5. One-Page Requirements Specification

### Functional Requirements (FR)
- **FR-01 (Trip Request):** Riders can submit trip requests with pickup/destination geographic coordinates, formatted addresses, and estimated fare.
- **FR-02 (Driver Assignment):** Drivers can query available trips and accept a trip, locking vehicle and driver identifiers onto the trip.
- **FR-03 (Controlled Lifecycle):** Trips must follow a strict finite state machine: `REQUESTED` $\rightarrow$ `ACCEPTED` $\rightarrow$ `IN_PROGRESS` $\rightarrow$ `COMPLETED`, with defined cancellation branches.
- **FR-04 (Single Active Trip per Rider):** At most one active trip (`REQUESTED`, `ACCEPTED`, `IN_PROGRESS`) is permitted per rider at any given moment.
- **FR-05 (Single Active Trip per Driver):** At most one active trip (`ACCEPTED`, `IN_PROGRESS`) is permitted per driver at any given moment.
- **FR-06 (Immutable Fare Snapshot):** Fare amount and currency are frozen upon trip creation/acceptance and cannot be recalculated after completion.
- **FR-07 (Driver & Vehicle Snapshotting):** The driver’s full name and vehicle description are permanently snapshotted into the trip record upon acceptance.
- **FR-08 (Exact Monetary Settlement):** A payment records the finalized transaction as exact integer minor units paired with an ISO-4217 currency code, never a floating-point value, so no amount can lose precision; each payment carries a unique provider reference that makes settlement idempotent.
- **FR-09 (Gated Reviews):** Reviews can only be submitted for `COMPLETED` trips; attempts to review active or cancelled trips are rejected.
- **FR-10 (Review Cardinality):** Exactly zero or one review can exist for a given trip.
- **FR-11 (Payment Completion Gating):** A payment can only be captured for a `COMPLETED` trip. Direct inserts against a non-completed trip are rejected by the database engine, not merely by API validation.

### Non-Functional Requirements (NFR)
- **NFR-01 (Non-Sequential Identifiers):** All public-facing entity identifiers must be cryptographically unpredictable, non-sequential UUIDs (UUIDv4/UUIDv7) to prevent enumeration attacks.
- **NFR-02 (Relational Integrity & Deep Enforcement):** Business rules must be guaranteed by PostgreSQL declarative constraints, partial unique indexes, check constraints, and triggers rather than relying solely on API logic.
- **NFR-03 (Monetary Integrity):** Monetary figures must strictly use 64-bit integer minor units (e.g. cents, kobo) with ISO-4217 three-letter currency codes. Floating point types (`FLOAT`, `DOUBLE`, `REAL`) are strictly banned.
- **NFR-04 (Predictable API Contracts):** Standardized HTTP status codes, structured JSON payloads, uniform error envelopes, and explicit validation schemas across all endpoints.
- **NFR-05 (Idempotency Safeguards):** Critical mutations (trip requests, trip acceptances, payment captures) must provide deterministic idempotency keys or state-gate guards.
- **NFR-06 (Optimized Query Paths):** High-frequency queries (active trip lookup, nearby available trips, driver trip history) must be backed by tailored compound and partial B-Tree indexes.
- **NFR-07 (Auditability & Safe Deletion):** Financial and transportation ledger records (`Trip`, `Payment`, `Review`) must never be hard-deleted. Soft deletes (`deleted_at`) are reserved for master profile records (`Rider`, `Driver`, `Vehicle`).

### Out of Scope (Explicitly Excluded)
To preserve architectural focus and adhere to the proof-layer scope, the following capabilities are deferred:
- Machine-learning-based geospatial driver dispatch & matching algorithms.
- Third-party mapping SDK integrations (Google Maps, Mapbox, OSRM).
- Real-time mobile GPS telematics ingest pipeline.
- Dynamic surge-pricing supply/demand econometric engines.
- Full merchant payment gateway orchestration (Stripe, Adyen, Paystack webhooks/refunds).
- End-user authentication suites (OAuth2, OIDC, biometric multi-factor).
- Push notification APNS/FCM delivery networks.
- Production WebSocket cluster management.
- Web or mobile customer-facing client applications.
- Back-office analytics, BI dashboards, or data-lake ETL pipelines.

---

## 6. Requirements Traceability Matrix

| Requirement ID | Domain Rule / Requirement | Design Decision | Entity / Schema Enforcement | Proof / Evidence |
| :--- | :--- | :--- | :--- | :--- |
| **FR-04** | One rider cannot have multiple active trips simultaneously | Partial Unique Index on `(rider_id)` where status is active | `trips (rider_id)` WHERE `status IN ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS')` | Invalid Test #1 (Attempt duplicate active trip) |
| **FR-05** | One driver cannot handle conflicting active trips | Partial Unique Index on `(driver_id)` where status is active | `trips (driver_id)` WHERE `status IN ('ACCEPTED', 'IN_PROGRESS')` | Invalid Test #6 (`23505` on `idx_trips_single_active_driver`, both index branches) & database constraint schema test |
| **FR-03** | Completed trip cannot return to in-progress or cancelled | PostgreSQL Transition Trigger raising SQLSTATE exception | `trg_enforce_trip_status_transition` on `BEFORE UPDATE OF status` | Invalid Test #2 (Transition `COMPLETED` $\rightarrow$ `IN_PROGRESS`) |
| **FR-06** | Historical trip fare remains immutable | Fare snapshot columns on Trip record | `trips.fare_amount_minor`, `trips.currency` | Seed verification & Query #3 inspection |
| **FR-07** | Historical driver/vehicle identity remains stable | Denormalized snapshot strings on Trip | `trips.driver_name_snapshot`, `trips.vehicle_description_snapshot` | Query #3 inspection |
| **FR-08** | Settled money is exact, with no floating-point precision loss | 64-bit integer minor units + ISO-4217 currency + UNIQUE provider reference for idempotency | `trips.fare_amount_minor BIGINT`, `payments.amount_minor BIGINT`, `trips.currency VARCHAR(3)` and `payments.currency VARCHAR(3)` with `CHECK (length = 3)`, `payments.provider_reference VARCHAR(100) UNIQUE` | Schema definition, Invalid Test #4, Valid Test #1, route payment tests |
| **FR-09** | Reviews allowed only after trip is completed | PostgreSQL Validation Trigger checking Trip status on insert | `trg_enforce_review_completion` on `BEFORE INSERT ON reviews` | Invalid Test #3 (Review for `IN_PROGRESS` trip) |
| **FR-10** | At most one review per trip | Unique constraint on `trip_id` | `reviews.trip_id UNIQUE` | Schema definition |
| **FR-11** | A payment can only be captured for a completed trip | PostgreSQL Validation Trigger checking Trip status on insert, plus an API pre-check for a precise client-facing error | `trg_enforce_payment_completion` on `BEFORE INSERT ON payments` | Invalid Test #4 (`23514`, all four non-terminal statuses) & Valid Test #5 |
| **NFR-01** | Unpredictable, non-sequential IDs | UUID primary keys generated via `gen_random_uuid()` | All tables: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` | Schema definition |
| **NFR-06** | Sub-millisecond lookup for active rider trip | Partial unique index on `(rider_id)` restricted to active statuses | `idx_trips_single_active_rider` | Query Plan #3 (EXPLAIN ANALYZE) |
| **NFR-06** | High performance driver queue lookup | Partial index on `(requested_at DESC)` where trip is unassigned | `idx_trips_driver_available_queue` | Query Plan #1 (EXPLAIN ANALYZE) |
| **NFR-06** | Fast rider trip history with payment status | Partial index on `(rider_id, completed_at DESC)` where `COMPLETED` | `idx_trips_rider_completed` | Query Plan #2 (EXPLAIN ANALYZE) |
