# Skill: Ride-Hailing Architectural Patterns

## Core Invariants
- **Active Trip Isolation:** A rider or driver must never have overlapping active bookings.
  - Active statuses: `REQUESTED`, `ACCEPTED`, `IN_PROGRESS`
  - Implementation: PostgreSQL Partial Unique Index:
    ```sql
    CREATE UNIQUE INDEX idx_trips_single_active_rider 
    ON trips(rider_id) 
    WHERE status IN ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS');
    ```
- **Review Precondition:** A review cannot precede trip completion.
  - Enforced via `BEFORE INSERT` trigger on `reviews` verifying that the target trip has `status = 'COMPLETED'`.
- **Trip Lifecycle Transition:** Forbidden transitions (e.g. `COMPLETED` -> `IN_PROGRESS`, `CANCELLED` -> `ACCEPTED`) are rejected via `BEFORE UPDATE` trigger on `trips`.
- **Denormalized Historical Snapshots:** When an event completes, snapshot mutable profile metadata (driver name, vehicle make/model/plate, agreed fare) onto the immutable transaction record.
