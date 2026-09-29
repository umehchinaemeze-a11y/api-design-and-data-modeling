const http = require('http');
const { Client } = require('pg');
const { TARGET } = require('./lib/target');

/*
 * UrbanGlide REST API proof server.
 *
 * This speaks the canonical schema in migrations/001_initial_schema.sql against the
 * canonical database in README section 27. Two consequences worth stating:
 *
 *  1. The trip lifecycle is enforced by trg_enforce_trip_status_transition, which
 *     raises SQLSTATE 23514. This server therefore maps 23514 on a trips UPDATE to
 *     409 INVALID_STATE_TRANSITION rather than filtering on a custom P0001.
 *  2. The canonical schema has no stamping trigger and no payment trigger, so this
 *     server writes accepted_at / started_at / completed_at / cancelled_at itself
 *     (chk_trips_timestamps requires them) and checks payment eligibility before
 *     inserting. The rule that a payment is only captured for a COMPLETED trip is
 *     the one lifecycle rule NOT enforced by a database trigger in this schema.
 */

const PORT = process.env.PORT || 3000;
const DB_URL = TARGET.connectionString;

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
}

function sendError(res, statusCode, code, message, details = {}) {
    sendJson(res, statusCode, {
        error: {
            code,
            message,
            details
        }
    });
}

async function getDbClient() {
    const client = new Client({ connectionString: DB_URL });
    await client.connect();
    return client;
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            if (!body) return resolve({});
            try {
                resolve(JSON.parse(body));
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

/* Every 23514 raised against a trips UPDATE originates from the lifecycle
 * trigger or from the two structural trip CHECK constraints, so a single
 * mapping is correct for the accept / start / complete / cancel routes.
 * Per the error contract in README section 20, a state-machine conflict is
 * 409 Conflict, not 422. */
function sendTripViolation(res, dbErr) {
    if (dbErr.code === '23514') {
        return sendError(res, 409, 'INVALID_STATE_TRANSITION', dbErr.message);
    }
    if (dbErr.code === '23505' && dbErr.constraint === 'idx_trips_single_active_driver') {
        return sendError(res, 409, 'DRIVER_ALREADY_ON_TRIP', 'That driver is already assigned to an active trip.');
    }
    throw dbErr;
}

const server = http.createServer(async (req, res) => {
    const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost:3000'}`);
    const pathname = fullUrl.pathname;
    const query = Object.fromEntries(fullUrl.searchParams);
    const method = req.method;

    let client;
    try {
        client = await getDbClient();

        // 1. HEALTH / SYSTEM STATUS / API INDEX
        if (method === 'GET' && (pathname === '/' || pathname === '/api/v1' || pathname === '/api/v1/' || pathname === '/api/v1/health')) {
            const countsRes = await client.query(`
                SELECT
                    (SELECT count(*) FROM riders) AS riders_count,
                    (SELECT count(*) FROM drivers) AS drivers_count,
                    (SELECT count(*) FROM vehicles) AS vehicles_count,
                    (SELECT count(*) FROM trips) AS trips_count,
                    (SELECT count(*) FROM payments) AS payments_count,
                    (SELECT count(*) FROM reviews) AS reviews_count;
            `);
            return sendJson(res, 200, {
                service: 'UrbanGlide REST API Proof Server',
                version: 'v1',
                status: 'healthy',
                database: 'PostgreSQL 16 (Connected)',
                counts: countsRes.rows[0],
                endpoints: [
                    'GET  /api/v1/riders',
                    'GET  /api/v1/trips',
                    'GET  /api/v1/trips/:id',
                    'GET  /api/v1/riders/:id/active-trip',
                    'POST /api/v1/trips',
                    'POST /api/v1/trips/:id/accept',
                    'POST /api/v1/trips/:id/start',
                    'POST /api/v1/trips/:id/complete',
                    'POST /api/v1/trips/:id/cancel',
                    'POST /api/v1/trips/:id/payment',
                    'POST /api/v1/trips/:id/reviews'
                ]
            });
        }

        // 2. LIST TRIPS
        if (method === 'GET' && pathname === '/api/v1/trips') {
            const limit = Math.min(parseInt(query.limit) || 20, 100);
            const offset = parseInt(query.offset) || 0;
            const status = query.status;

            let sql = 'SELECT * FROM trips';
            const params = [];
            if (status) {
                params.push(String(status).toUpperCase());
                sql += ' WHERE status = $1';
            }
            params.push(limit, offset);
            sql += ` ORDER BY requested_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

            const result = await client.query(sql, params);
            return sendJson(res, 200, {
                data: result.rows,
                pagination: { limit, offset, count: result.rows.length }
            });
        }

        // 3a. LIST RIDERS (GET /api/v1/riders or /api/v1/riders/)
        if (method === 'GET' && (pathname === '/api/v1/riders' || pathname === '/api/v1/riders/')) {
            const limit = Math.min(parseInt(query.limit) || 20, 100);
            const offset = parseInt(query.offset) || 0;
            const result = await client.query(
                'SELECT id, name, email, phone, created_at FROM riders WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1 OFFSET $2',
                [limit, offset]
            );
            const countResult = await client.query('SELECT count(*) FROM riders WHERE deleted_at IS NULL');
            return sendJson(res, 200, {
                riders: result.rows,
                pagination: { limit, offset, total: parseInt(countResult.rows[0].count) }
            });
        }

        // 3b. GET ACTIVE TRIP FOR RIDER
        const activeTripMatch = pathname.match(/^\/api\/v1\/riders\/([0-9a-fA-F-]+)\/active-trip$/);
        if (method === 'GET' && activeTripMatch) {
            const riderId = activeTripMatch[1];
            const sql = `
                SELECT t.id AS trip_id, t.status, t.pickup_address, t.destination_address,
                       t.fare_amount_minor, t.currency, t.requested_at, t.accepted_at, t.started_at,
                       d.name AS driver_name, d.phone AS driver_phone,
                       v.make AS vehicle_make, v.model AS vehicle_model, v.registration_number AS vehicle_plate
                FROM trips t
                LEFT JOIN drivers d ON t.driver_id = d.id
                LEFT JOIN vehicles v ON t.vehicle_id = v.id
                WHERE t.rider_id = $1
                  AND t.status IN ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS')
                ORDER BY t.requested_at DESC
                LIMIT 1;
            `;
            const result = await client.query(sql, [riderId]);
            if (result.rows.length === 0) {
                return sendError(res, 404, 'ACTIVE_TRIP_NOT_FOUND', 'No active trip currently found for this rider.');
            }
            return sendJson(res, 200, { trip: result.rows[0] });
        }

        // 4. GET TRIP BY ID
        const tripByIdMatch = pathname.match(/^\/api\/v1\/trips\/([0-9a-fA-F-]+)$/);
        if (method === 'GET' && tripByIdMatch) {
            const tripId = tripByIdMatch[1];
            const result = await client.query('SELECT * FROM trips WHERE id = $1', [tripId]);
            if (result.rows.length === 0) {
                return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
            }
            return sendJson(res, 200, { trip: result.rows[0] });
        }

        // 5. REQUEST A TRIP (POST /api/v1/trips)
        if (method === 'POST' && pathname === '/api/v1/trips') {
            const body = await parseBody(req);
            const { riderId, pickupAddress, destinationAddress, pickupLatitude, pickupLongitude, destinationLatitude, destinationLongitude, fareAmountMinor, currency } = body;

            if (!riderId || !pickupAddress || !destinationAddress || !fareAmountMinor) {
                return sendError(res, 400, 'INVALID_PAYLOAD', 'Missing mandatory booking fields.');
            }

            try {
                const insertRes = await client.query(`
                    INSERT INTO trips (
                        rider_id, pickup_address, destination_address,
                        pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
                        fare_amount_minor, currency, status
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'REQUESTED')
                    RETURNING *;
                `, [
                    riderId, pickupAddress, destinationAddress,
                    pickupLatitude || 6.4281, pickupLongitude || 3.4219,
                    destinationLatitude || 6.4500, destinationLongitude || 3.4000,
                    fareAmountMinor, currency || 'NGN'
                ]);
                return sendJson(res, 201, { trip: insertRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === '23505' && dbErr.constraint === 'idx_trips_single_active_rider') {
                    return sendError(res, 409, 'TRIP_ALREADY_ACTIVE', 'The rider already has an active trip in progress.', {
                        riderId
                    });
                }
                throw dbErr;
            }
        }

        // 6. ACCEPT TRIP (POST /api/v1/trips/:id/accept)
        const acceptMatch = pathname.match(/^\/api\/v1\/trips\/([0-9a-fA-F-]+)\/accept$/);
        if (method === 'POST' && acceptMatch) {
            const tripId = acceptMatch[1];
            const body = await parseBody(req);
            const { driverId, vehicleId } = body;

            if (!driverId || !vehicleId) {
                return sendError(res, 400, 'MISSING_DRIVER_VEHICLE', 'driverId and vehicleId are required to accept a trip.');
            }

            try {
                // driver_name_snapshot / vehicle_description_snapshot are deliberate
                // historical copies: the live driver record may be edited or soft deleted later.
                const updateRes = await client.query(`
                    UPDATE trips
                    SET status = 'ACCEPTED',
                        driver_id = $1,
                        vehicle_id = $2,
                        accepted_at = NOW(),
                        driver_name_snapshot = (SELECT name FROM drivers WHERE id = $1),
                        vehicle_description_snapshot = (
                            SELECT make || ' ' || model FROM vehicles WHERE id = $2
                        )
                    WHERE id = $3
                    RETURNING *;
                `, [driverId, vehicleId, tripId]);

                if (updateRes.rows.length === 0) {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                return sendJson(res, 200, { trip: updateRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === '23503') {
                    return sendError(res, 404, 'DRIVER_OR_VEHICLE_NOT_FOUND', 'The supplied driver or vehicle does not exist.');
                }
                if (dbErr.code === '23514' || dbErr.code === '23505') {
                    return sendTripViolation(res, dbErr);
                }
                throw dbErr;
            }
        }

        // 7. COMPLETE TRIP (POST /api/v1/trips/:id/complete)
        const completeMatch = pathname.match(/^\/api\/v1\/trips\/([0-9a-fA-F-]+)\/complete$/);
        if (method === 'POST' && completeMatch) {
            const tripId = completeMatch[1];
            try {
                const updateRes = await client.query(`
                    UPDATE trips
                    SET status = 'COMPLETED',
                        completed_at = NOW()
                    WHERE id = $1
                    RETURNING *;
                `, [tripId]);

                if (updateRes.rows.length === 0) {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                return sendJson(res, 200, { trip: updateRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === '23514' || dbErr.code === '23505') {
                    return sendTripViolation(res, dbErr);
                }
                throw dbErr;
            }
        }

        // 8. SUBMIT REVIEW (POST /api/v1/trips/:id/reviews)
        // Path is the plural collection sub-resource, matching the contract in
        // README section 19 (Endpoint 5).
        const reviewMatch = pathname.match(/^\/api\/v1\/trips\/([0-9a-fA-F-]+)\/reviews$/);
        if (method === 'POST' && reviewMatch) {
            const tripId = reviewMatch[1];
            const body = await parseBody(req);
            const { rating, comment } = body;

            if (!rating) {
                return sendError(res, 400, 'MISSING_RATING', 'Rating is required (1-5).');
            }

            try {
                // reviews carries denormalised rider_id / driver_id so a review is read
                // without joining trips; trg_enforce_review_completion asserts both match.
                const insertRes = await client.query(`
                    INSERT INTO reviews (trip_id, rider_id, driver_id, rating, comment)
                    SELECT t.id, t.rider_id, t.driver_id, $2, $3
                    FROM trips t
                    WHERE t.id = $1
                    RETURNING *;
                `, [tripId, rating, comment || null]);

                if (insertRes.rows.length === 0) {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                return sendJson(res, 201, { review: insertRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === '23503') {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                if (dbErr.code === '23505' && dbErr.constraint === 'reviews_trip_id_key') {
                    return sendError(res, 409, 'REVIEW_ALREADY_EXISTS', 'A review has already been submitted for this trip.');
                }
                if (dbErr.code === '23514') {
                    if (dbErr.constraint === 'reviews_rating_check') {
                        return sendError(res, 400, 'INVALID_RATING', 'Rating must be an integer between 1 and 5.');
                    }
                    if (/only permitted for COMPLETED trips/.test(dbErr.message)) {
                        return sendError(res, 409, 'TRIP_NOT_COMPLETED', dbErr.message);
                    }
                    return sendError(res, 403, 'REVIEW_PARTICIPANT_MISMATCH', dbErr.message);
                }
                throw dbErr;
            }
        }

        // 9. START TRIP (POST /api/v1/trips/:id/start)
        const startMatch = pathname.match(/^\/api\/v1\/trips\/([0-9a-fA-F-]+)\/start$/);
        if (method === 'POST' && startMatch) {
            const tripId = startMatch[1];

            try {
                // No status precondition in the WHERE clause: trg_enforce_trip_status_transition
                // permits only ACCEPTED -> IN_PROGRESS, so the database remains the single
                // authority on the lifecycle state machine. started_at is written here
                // because chk_trips_timestamps requires it for IN_PROGRESS.
                const updateRes = await client.query(`
                    UPDATE trips
                    SET status = 'IN_PROGRESS',
                        started_at = NOW()
                    WHERE id = $1
                    RETURNING *;
                `, [tripId]);

                if (updateRes.rows.length === 0) {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                return sendJson(res, 200, { trip: updateRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === '23514' || dbErr.code === '23505') {
                    return sendTripViolation(res, dbErr);
                }
                throw dbErr;
            }
        }

        // 10. CANCEL TRIP (POST /api/v1/trips/:id/cancel)
        const cancelMatch = pathname.match(/^\/api\/v1\/trips\/([0-9a-fA-F-]+)\/cancel$/);
        if (method === 'POST' && cancelMatch) {
            const tripId = cancelMatch[1];
            const body = await parseBody(req);
            const { reason } = body;

            if (reason !== undefined && reason !== null && typeof reason !== 'string') {
                return sendError(res, 400, 'INVALID_PAYLOAD', 'reason must be a string when provided.');
            }

            try {
                // Cancellation is legal only from REQUESTED / ACCEPTED / IN_PROGRESS per
                // trg_enforce_trip_status_transition; COMPLETED and CANCELLED are terminal.
                // Re-cancelling is a no-op because the trigger short-circuits on an
                // unchanged status.
                const updateRes = await client.query(`
                    UPDATE trips
                    SET status = 'CANCELLED',
                        cancelled_at = NOW(),
                        cancellation_reason = $2
                    WHERE id = $1
                    RETURNING *;
                `, [tripId, reason || null]);

                if (updateRes.rows.length === 0) {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                return sendJson(res, 200, { trip: updateRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === '23514' || dbErr.code === '23505') {
                    if (/COMPLETED trips cannot transition/.test(dbErr.message || '')) {
                        return sendError(res, 409, 'TRIP_ALREADY_COMPLETED', 'A completed trip cannot be cancelled.');
                    }
                    return sendTripViolation(res, dbErr);
                }
                throw dbErr;
            }
        }

        // 11. SETTLE TRIP PAYMENT (POST /api/v1/trips/:id/payment)
        const paymentMatch = pathname.match(/^\/api\/v1\/trips\/([0-9a-fA-F-]+)\/payment$/);
        if (method === 'POST' && paymentMatch) {
            const tripId = paymentMatch[1];
            const body = await parseBody(req);
            const { amountMinor, currency, providerReference } = body;

            if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
                return sendError(res, 400, 'INVALID_AMOUNT', 'amountMinor must be a positive integer expressed in minor units (e.g. kobo, cents).');
            }

            // provider_reference is NOT NULL UNIQUE in the canonical schema, so an
            // omitted reference is synthesised deterministically from the trip and amount.
            const reference = providerReference
                || `auto_${tripId.replace(/-/g, '').slice(0, 16)}_${amountMinor}`;

            try {
                // Eligibility first. payments.status is payment_status_enum, so a settled
                // capture is written directly as COMPLETED with paid_at set; the canonical
                // schema has no payment trigger, so the COMPLETED-trip precondition is
                // evaluated here.
                const tripRes = await client.query('SELECT status FROM trips WHERE id = $1', [tripId]);
                if (tripRes.rows.length === 0) {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                if (tripRes.rows[0].status !== 'COMPLETED') {
                    return sendError(res, 409, 'TRIP_NOT_COMPLETED',
                        `Cannot capture payment for trip ${tripId}: trip status is ${tripRes.rows[0].status}, not COMPLETED.`,
                        { tripId });
                }

                const insertRes = await client.query(`
                    INSERT INTO payments (trip_id, amount_minor, currency, status, provider_reference, paid_at)
                    VALUES ($1, $2, $3, 'COMPLETED', $4, NOW())
                    RETURNING *;
                `, [tripId, amountMinor, currency || 'NGN', reference]);

                return sendJson(res, 201, { payment: insertRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === '23503') {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                if (dbErr.code === '23505' && dbErr.constraint === 'payments_trip_id_key') {
                    return sendError(res, 409, 'PAYMENT_ALREADY_EXISTS', 'A payment already exists for this trip.', { tripId });
                }
                if (dbErr.code === '23505' && dbErr.constraint === 'payments_provider_reference_key') {
                    return sendError(res, 409, 'DUPLICATE_PROVIDER_REFERENCE', 'That provider reference is already recorded against another payment.', { providerReference: reference });
                }
                if (dbErr.code === '23514') {
                    return sendError(res, 400, 'INVALID_PAYMENT', 'Payment rejected by database validation (amount_minor must be positive, currency must be 3 characters).');
                }
                throw dbErr;
            }
        }

        // 404 Fallback
        return sendError(res, 404, 'ENDPOINT_NOT_FOUND', `Route ${method} ${pathname} not found.`);

    } catch (err) {
        console.error('Unhandled request error:', err);
        return sendError(res, 500, 'INTERNAL_SERVER_ERROR', err.message || 'An unexpected error occurred.');
    } finally {
        if (client) await client.end();
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n[ERROR] Port ${PORT} is already in use.`);
        console.error('        A previous dev server is likely still running. Find and stop it:');
        console.error(`          Windows  : netstat -ano | findstr :${PORT}   then  taskkill /PID <pid> /F`);
        console.error(`          Or retry: PORT=3001 npm run dev`);
        console.error('        Port override on PowerShell: $env:PORT=3001; npm run dev\n');
        process.exit(1);
    }
    throw err;
});

server.listen(PORT, () => {
    console.log(`================================================================`);
    console.log(`  UrbanGlide API Server running at http://localhost:${PORT}/api/v1`);
    console.log(`================================================================`);
    console.log(`  Health Check & Counts: GET http://localhost:${PORT}/api/v1/health`);
    console.log(`  List Riders          : GET http://localhost:${PORT}/api/v1/riders`);
    console.log(`  List Trips           : GET http://localhost:${PORT}/api/v1/trips`);
    console.log(`  Active Trip Check    : GET http://localhost:${PORT}/api/v1/riders/<id>/active-trip`);
    console.log(`================================================================\n`);
});
