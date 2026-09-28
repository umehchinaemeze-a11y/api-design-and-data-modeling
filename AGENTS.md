# AGENTS.md — System Working Directives

## Mission Scope
This repository is an architectural proof and design specification for the **UrbanGlide Ride-Hailing Platform**.
Our scope is strictly bounded:
1. Requirements & PRD definition
2. Entity relational data modeling & ER diagrams
3. Hard architectural decisions (money, status lifecycle, denormalization, deletion, IDs)
4. Comprehensive API specification (endpoints, payloads, status codes, errors, idempotency, pagination)
5. Architectural trade-off evaluations (Over-fetching & GraphQL, Real-time transport SSE vs WebSockets)
6. Proof layer implementation:
   - PostgreSQL schema with declarative constraints, triggers, and indexes
   - Reproducible migration and realistic seed dataset
   - Five representative queries
   - Two actual EXPLAIN ANALYZE query plans
   - Three intentionally invalid operations rejected by the database engine
7. Comprehensive README documentation, evidence package, and engineering defence answers.

## Explicit Anti-Goals
- Do NOT build a full frontend, UI mockups, or landing page.
- Do NOT implement the entire REST API controllers or Express/Nest routing services.
- Do NOT create microservice architectures or distributed messaging queues.
- Do NOT fabricate query plans or constraint violations.
- Do NOT leave any constraint unverified against a running PostgreSQL database.

## Architecture Guidelines
- **Storage of Money:** Always `BIGINT` minor units with ISO-4217 string currency.
- **Identifiers:** Unpredictable UUIDs.
- **Status Fields:** Postgres `ENUM` with state machine enforced by DB triggers.
- **Audit Trails:** Immutable append-only ledgers for financial transactions (`payments`) and trip manifests (`trips`).
- **Constraint Enforcement:** Never trust the application layer alone for domain invariants.
