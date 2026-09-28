# Engineering Standards & Architectural Invariants

## Database Standards
1. **Never use floating-point types for monetary values:** All monetary amounts must be stored as 64-bit signed integers representing minor currency units (e.g. cents, kobo, pence) accompanied by an uppercase 3-character ISO-4217 currency code.
2. **Never use sequential public identifiers:** All public identifiers must be generated UUIDs (`UUIDv4` or `UUIDv7`) to eliminate enumeration attacks.
3. **Controlled Lifecycles:** Never store free-text status strings. Use PostgreSQL native `ENUM` types coupled with database trigger checks for previous-to-next state validations.
4. **Declarative Invariants First:** Domain invariants (e.g. at most one active trip per rider, review only allowed for completed trips) must be enforced at the database level via partial unique indexes and triggers.
5. **Selective Indexing:** Every index must directly serve a specific high-frequency query pattern from the core product actions. Index write and memory overhead must be explicitly justified.

## API Standards
1. **URI Conventions:** Versioned paths (`/api/v1/...`) with plural nouns.
2. **State Mutations:** Unrestricted resource patching (`PATCH /trips/:id` with arbitrary body) is strictly prohibited. State transitions must be modeled as explicit sub-resource action endpoints (e.g. `POST /api/v1/trips/:id/accept`).
3. **Error Consistency:** All non-2xx responses must adhere to a standardized error envelope: `{ "error": { "code": string, "message": string, "details": any } }`.
4. **Idempotency:** State mutations and financial transactions must support explicit deduplication via idempotency keys or state guards.
