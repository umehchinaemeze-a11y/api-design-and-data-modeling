const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PORT = Number(process.env.TEST_PORT || 3111);
const ORIGIN = `http://localhost:${PORT}`;
const BASE = process.env.BASE || `${ORIGIN}/api/v1`;

let server = null;

async function waitForServer(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${BASE}/health`);
            if (res.ok) return true;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

async function reseed() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:15436/rideflow?sslmode=disable'
    });
    await client.connect();
    await client.query(fs.readFileSync(path.join(__dirname, '../sql/seed.sql'), 'utf8'));
    await client.end();
}

function stopServer() {
    if (server && !server.killed) {
        try { server.kill(); } catch (e) {}
    }
}

const TRIP = {
    requested: 'ca111111-1111-4111-d111-111111111111',
    accepted: 'ca222222-2222-4222-d222-222222222222',
    inProgress: 'ca333333-3333-4333-d333-333333333333',
    completedWithPayment: 'ca444444-4444-4444-d444-444444444444',
    completedNoReview: 'ca555555-5555-4555-d555-555555555555',
    cancelled: 'ca666666-6666-4666-d666-666666666666'
};
const UNKNOWN = '00000000-0000-0000-0000-000000000000';
const DRIVER = 'da222222-2222-4222-b222-222222222222';
const VEHICLE = 'ba222222-2222-4222-c222-222222222222';
const RIDER_FREE = '11111111-1111-4111-a111-111111111111';
const DRIVER_FREE = 'da333333-3333-4333-b333-333333333333';
const VEHICLE_FREE = 'ba333333-3333-4333-c333-333333333333';

let pass = 0, fail = 0;
const rows = [];

function check(name, cond, detail) {
    if (cond) { pass++; rows.push(`  [PASS] ${name}`); }
    else { fail++; rows.push(`  [FAIL] ${name} :: ${detail}`); }
}

async function call(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${path}`, opts);
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, body: json };
}

async function main() {
    console.log('================================================================');
    console.log('        RIDEFLOW API ROUTE VERIFICATION (start/cancel/payment)   ');
    console.log('================================================================\n');

    // Deterministic baseline: re-seed, then boot a throwaway server on TEST_PORT
    await reseed();
    server = spawn(process.execPath, [path.join(__dirname, 'dev.js')], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: 'ignore'
    });
    if (!await waitForServer()) {
        stopServer();
        console.error(`Server did not become ready on ${ORIGIN}. Is PostgreSQL reachable?`);
        process.exit(1);
    }

    console.log('GROUP A: POST /api/v1/trips/:id/start');
    {
        const r = await call('POST', `/trips/${TRIP.accepted}/start`);
        check('start on accepted trip -> 200 + status in_progress',
            r.status === 200 && r.body?.trip?.status === 'in_progress', `status=${r.status} body=${JSON.stringify(r.body)}`);
        check('start stamps started_at (set by DB trigger)',
            r.body?.trip?.started_at !== null && r.body?.trip?.started_at !== undefined,
            `started_at=${r.body?.trip?.started_at}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.requested}/start`);
        check('start on requested trip -> 422 INVALID_STATE_TRANSITION',
            r.status === 422 && r.body?.error?.code === 'INVALID_STATE_TRANSITION', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.completedWithPayment}/start`);
        check('start on completed trip -> 422 INVALID_STATE_TRANSITION',
            r.status === 422 && r.body?.error?.code === 'INVALID_STATE_TRANSITION', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${UNKNOWN}/start`);
        check('start on unknown trip -> 404 TRIP_NOT_FOUND',
            r.status === 404 && r.body?.error?.code === 'TRIP_NOT_FOUND', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }

    console.log('GROUP B: POST /api/v1/trips/:id/cancel');
    {
        const r = await call('POST', `/trips/${TRIP.inProgress}/cancel`);
        check('cancel on in_progress trip -> 200 + status cancelled',
            r.status === 200 && r.body?.trip?.status === 'cancelled', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.requested}/cancel`, { reason: 'Rider changed plans' });
        check('cancel on requested trip with reason -> 200 + status cancelled',
            r.status === 200 && r.body?.trip?.status === 'cancelled', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.completedNoReview}/cancel`);
        check('cancel on completed trip -> 422 TRIP_ALREADY_COMPLETED',
            r.status === 422 && r.body?.error?.code === 'TRIP_ALREADY_COMPLETED', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.cancelled}/cancel`);
        check('cancel on already-cancelled trip -> 200 idempotent no-op (matrix: No-op)',
            r.status === 200 && r.body?.trip?.status === 'cancelled', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${UNKNOWN}/cancel`);
        check('cancel on unknown trip -> 404 TRIP_NOT_FOUND',
            r.status === 404 && r.body?.error?.code === 'TRIP_NOT_FOUND', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.completedNoReview}/cancel`, '{}');
        check('cancel with no body -> 404/422 handled without 500',
            r.status !== 500, `status=${r.status} body=${JSON.stringify(r.body)}`);
    }

    console.log('GROUP C: POST /api/v1/trips/:id/payment');
    let payable = null;
    {
        const r = await call('POST', '/trips', {
            riderId: RIDER_FREE, pickupAddress: '1 Market St', destinationAddress: '2 Mission St',
            fareAmountMinor: 3450, currency: 'USD'
        });
        check('setup: create trip for full lifecycle -> 201 requested',
            r.status === 201 && r.body?.trip?.status === 'requested', `status=${r.status} body=${JSON.stringify(r.body)}`);
        payable = r.body?.trip?.id;
    }
    {
        const r = await call('POST', `/trips/${payable}/payment`, { amountMinor: 3450, currency: 'USD', providerReference: 'ch_elig_requested' });
        check('payment on requested trip -> 422 TRIP_NOT_COMPLETED (trg_validate_payment_trip_completion)',
            r.status === 422 && r.body?.error?.code === 'TRIP_NOT_COMPLETED', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${payable}/accept`, { driverId: DRIVER_FREE, vehicleId: VEHICLE_FREE });
        check('setup: accept -> 200 accepted',
            r.status === 200 && r.body?.trip?.status === 'accepted', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${payable}/payment`, { amountMinor: 3450, currency: 'USD', providerReference: 'ch_elig_accepted' });
        check('payment on accepted trip -> 422 TRIP_NOT_COMPLETED',
            r.status === 422 && r.body?.error?.code === 'TRIP_NOT_COMPLETED', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${payable}/start`, {});
        check('setup: start -> 200 in_progress',
            r.status === 200 && r.body?.trip?.status === 'in_progress', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${payable}/payment`, { amountMinor: 3450, currency: 'USD', providerReference: 'ch_elig_in_progress' });
        check('payment on in_progress trip -> 422 TRIP_NOT_COMPLETED',
            r.status === 422 && r.body?.error?.code === 'TRIP_NOT_COMPLETED', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${payable}/complete`, {});
        check('setup: complete -> 200 completed',
            r.status === 200 && r.body?.trip?.status === 'completed', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${payable}/payment`, { amountMinor: 2200, currency: 'US' });
        check('payment with 2-char currency on completed trip -> 400 INVALID_PAYMENT (DB CHECK 23514)',
            r.status === 400 && r.body?.error?.code === 'INVALID_PAYMENT', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    for (const [label, amount] of [['zero', 0], ['negative', -100], ['string', '3850'], ['float', 10.5], ['missing', undefined]]) {
        const r = await call('POST', `/trips/${payable}/payment`, { amountMinor: amount });
        check(`payment with ${label} amountMinor -> 400 INVALID_AMOUNT`,
            r.status === 400 && r.body?.error?.code === 'INVALID_AMOUNT', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${payable}/payment`, { amountMinor: 500, providerReference: 'ch_rideflow_proof_t4' });
        check('payment with duplicate providerReference -> 409 DUPLICATE_PROVIDER_REFERENCE',
            r.status === 409 && r.body?.error?.code === 'DUPLICATE_PROVIDER_REFERENCE', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${payable}/payment`, { amountMinor: 3450, currency: 'USD', providerReference: 'ch_route_test_unique' });
        check('payment on completed trip -> 201',
            r.status === 201 && r.body?.payment, `status=${r.status} body=${JSON.stringify(r.body)}`);
        check('payment settles to status succeeded (via DB trigger)',
            r.body?.payment?.status === 'succeeded', `status=${r.body?.payment?.status}`);
        check('payment stamps paid_at (set by DB trigger)',
            !!r.body?.payment?.paid_at, `paid_at=${r.body?.payment?.paid_at}`);
        check('payment records minor units + currency',
            String(r.body?.payment?.amount_minor) === '3450' && r.body?.payment?.currency === 'USD',
            `amount=${r.body?.payment?.amount_minor} currency=${r.body?.payment?.currency}`);
        check('payment response exposes snake_case DB column names (amount_minor, provider_reference)',
            r.body?.payment?.amount_minor !== undefined && r.body?.payment?.provider_reference !== undefined
                && r.body?.payment?.amountMinor === undefined,
            `keys=${JSON.stringify(Object.keys(r.body?.payment || {}))}`);
    }
    {
        const r = await call('POST', `/trips/${payable}/payment`, { amountMinor: 100 });
        check('second payment on same trip -> 409 PAYMENT_ALREADY_EXISTS',
            r.status === 409 && r.body?.error?.code === 'PAYMENT_ALREADY_EXISTS', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.cancelled}/payment`, { amountMinor: 1500 });
        check('payment on cancelled trip -> 422 TRIP_NOT_COMPLETED',
            r.status === 422 && r.body?.error?.code === 'TRIP_NOT_COMPLETED', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${UNKNOWN}/payment`, { amountMinor: 100 });
        check('payment on unknown trip -> 404 TRIP_NOT_FOUND',
            r.status === 404 && r.body?.error?.code === 'TRIP_NOT_FOUND', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const c = await call('POST', '/trips', {
            riderId: RIDER_FREE, pickupAddress: '3 Howard St', destinationAddress: '4 Pine St',
            fareAmountMinor: 1500, currency: 'USD'
        });
        const t2 = c.body?.trip?.id;
        await call('POST', `/trips/${t2}/accept`, { driverId: DRIVER_FREE, vehicleId: VEHICLE_FREE });
        await call('POST', `/trips/${t2}/start`, {});
        await call('POST', `/trips/${t2}/complete`, {});
        const r = await call('POST', `/trips/${t2}/payment`, { amountMinor: 1500, providerReference: 'ch_default_currency' });
        check('payment without currency defaults to USD -> 201',
            r.status === 201 && r.body?.payment?.currency === 'USD', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }

    console.log('GROUP D: NO REGRESSION on pre-existing routes');
    {
        const r = await call('GET', '/health');
        check('GET /health -> 200 healthy', r.status === 200 && r.body?.status === 'healthy', `status=${r.status}`);
        check('health advertises all 10 documented endpoints',
            Array.isArray(r.body?.endpoints) && r.body.endpoints.length === 10,
            `endpoints=${JSON.stringify(r.body?.endpoints)}`);
    }
    {
        const r = await call('GET', '/trips?limit=3');
        check('GET /trips -> 200 collection envelope',
            r.status === 200 && Array.isArray(r.body?.data) && r.body.pagination, `status=${r.status}`);
    }
    {
        const r = await call('GET', `/trips/${TRIP.completedWithPayment}`);
        check('GET /trips/:id -> 200', r.status === 200 && r.body?.trip?.id === TRIP.completedWithPayment, `status=${r.status}`);
    }
    {
        const r = await call('GET', `/trips/${UNKNOWN}`);
        check('GET /trips/:id unknown -> 404 TRIP_NOT_FOUND',
            r.status === 404 && r.body?.error?.code === 'TRIP_NOT_FOUND', `status=${r.status}`);
    }
    {
        const r = await call('GET', '/riders/33333333-3333-4333-a333-333333333333/active-trip');
        check('GET /riders/:id/active-trip for rider with no active trip -> 404 ACTIVE_TRIP_NOT_FOUND',
            r.status === 404 && r.body?.error?.code === 'ACTIVE_TRIP_NOT_FOUND', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('GET', '/riders/22222222-2222-4222-a222-222222222222/active-trip');
        check('GET /riders/:id/active-trip for rider with active trip -> 200',
            r.status === 200 && r.body?.trip, `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.requested}/accept`, { driverId: DRIVER, vehicleId: VEHICLE });
        check('POST /trips/:id/accept on cancelled trip -> 422 INVALID_STATE_TRANSITION',
            r.status === 422 && r.body?.error?.code === 'INVALID_STATE_TRANSITION', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.inProgress}/complete`);
        check('POST /trips/:id/complete on cancelled trip -> 422 INVALID_STATE_TRANSITION',
            r.status === 422 && r.body?.error?.code === 'INVALID_STATE_TRANSITION', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.inProgress}/review`, { rating: 5 });
        check('POST /trips/:id/review on cancelled trip -> 422 TRIP_NOT_COMPLETED',
            r.status === 422 && r.body?.error?.code === 'TRIP_NOT_COMPLETED', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await call('POST', `/trips/${TRIP.completedNoReview}/review`, { rating: 6 });
        check('POST /trips/:id/review rating 6 -> 400 INVALID_RATING',
            r.status === 400 && r.body?.error?.code === 'INVALID_RATING', `status=${r.status} body=${JSON.stringify(r.body)}`);
    }
    {
        const r = await fetch(`${ORIGIN}/`);
        const j = await r.json();
        check('GET / (true server root) still serves health -> 200', r.status === 200 && j?.status === 'healthy', `status=${r.status}`);
    }
    {
        const r = await fetch(`${ORIGIN}/api/v1`);
        const j = await r.json();
        check('GET /api/v1 (API index) -> 200 serves service info and endpoints',
            r.status === 200 && j?.status === 'healthy', `status=${r.status} body=${JSON.stringify(j)}`);
    }
    {
        const r = await call('GET', '/trips/00000000-0000-0000-0000-000000000000/start');
        check('GET on action sub-resource -> 404 (method mismatch, not 200)',
            r.status === 404, `status=${r.status}`);
    }

    console.log('');
    rows.forEach(r => console.log(r));
    console.log('\n================================================================');
    console.log(`ROUTE TEST RESULTS: ${pass} PASSED, ${fail} FAILED`);
    console.log('================================================================\n');
    stopServer();
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => { stopServer(); console.error('Harness error:', err); process.exit(1); });
