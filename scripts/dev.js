const http = require('http');
const { Client } = require('pg');

const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:15436/rideflow?sslmode=disable';

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
                service: 'RideFlow REST API Proof Server',
                version: 'v1',
                status: 'healthy',
                database: 'PostgreSQL 16 (Connected)',
                counts: countsRes.rows[0],
                endpoints: [
                    'GET  /api/v1/trips',
                    'GET  /api/v1/trips/:id',
                    'GET  /api/v1/riders/:id/active-trip',
                    'POST /api/v1/trips',
                    'POST /api/v1/trips/:id/accept',
                    'POST /api/v1/trips/:id/start',
                    'POST /api/v1/trips/:id/complete',
                    'POST /api/v1/trips/:id/cancel',
                    'POST /api/v1/trips/:id/payment',
                    'POST /api/v1/trips/:id/review'
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
                params.push(status);
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

        // 3b. GET ACTIVE TRIP FOR RIDER (Query 3)
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
                  AND t.status IN ('requested', 'accepted', 'in_progress');
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
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'requested')
                    RETURNING *;
                `, [
                    riderId, pickupAddress, destinationAddress,
                    pickupLatitude || 37.77, pickupLongitude || -122.41,
                    destinationLatitude || 37.78, destinationLongitude || -122.40,
                    fareAmountMinor, currency || 'USD'
                ]);
                return sendJson(res, 201, { trip: insertRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === '23505' && dbErr.constraint === 'idx_trips_rider_active') {
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
                const updateRes = await client.query(`
                    UPDATE trips
                    SET status = 'accepted', driver_id = $1, vehicle_id = $2
                    WHERE id = $3
                    RETURNING *;
                `, [driverId, vehicleId, tripId]);

                if (updateRes.rows.length === 0) {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                return sendJson(res, 200, { trip: updateRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === 'P0001') {
                    return sendError(res, 422, 'INVALID_STATE_TRANSITION', dbErr.message);
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
                    SET status = 'completed'
                    WHERE id = $1
                    RETURNING *;
                `, [tripId]);

                if (updateRes.rows.length === 0) {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                return sendJson(res, 200, { trip: updateRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === 'P0001') {
                    return sendError(res, 422, 'INVALID_STATE_TRANSITION', dbErr.message);
                }
                throw dbErr;
            }
        }

        // 8. SUBMIT REVIEW (POST /api/v1/trips/:id/review)
        const reviewMatch = pathname.match(/^\/api\/v1\/trips\/([0-9a-fA-F-]+)\/review$/);
        if (method === 'POST' && reviewMatch) {
            const tripId = reviewMatch[1];
            const body = await parseBody(req);
            const { rating, comment } = body;

            if (!rating) {
                return sendError(res, 400, 'MISSING_RATING', 'Rating is required (1-5).');
            }

            try {
                const insertRes = await client.query(`
                    INSERT INTO reviews (trip_id, rating, comment)
                    VALUES ($1, $2, $3)
                    RETURNING *;
                `, [tripId, rating, comment || null]);
                return sendJson(res, 201, { review: insertRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === 'P0001') {
                    return sendError(res, 422, 'TRIP_NOT_COMPLETED', dbErr.message);
                }
                if (dbErr.code === '23505') {
                    return sendError(res, 409, 'REVIEW_ALREADY_EXISTS', 'A review has already been submitted for this trip.');
                }
                if (dbErr.code === '23514') {
                    return sendError(res, 400, 'INVALID_RATING', 'Rating must be an integer between 1 and 5.');
                }
                throw dbErr;
            }
        }

        // 9. START TRIP (POST /api/v1/trips/:id/start)
        const startMatch = pathname.match(/^\/api\/v1\/trips\/([0-9a-fA-F-]+)\/start$/);
        if (method === 'POST' && startMatch) {
            const tripId = startMatch[1];

            try {
                // No status precondition in the WHERE clause: trg_validate_trip_status_transition
                // permits only accepted -> in_progress and stamps started_at, so the database
                // remains the single authority on the lifecycle state machine.
                const updateRes = await client.query(`
                    UPDATE trips
                    SET status = 'in_progress'
                    WHERE id = $1
                    RETURNING *;
                `, [tripId]);

                if (updateRes.rows.length === 0) {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                return sendJson(res, 200, { trip: updateRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === 'P0001') {
                    return sendError(res, 422, 'INVALID_STATE_TRANSITION', dbErr.message);
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
                // Cancellation is legal only from requested / accepted / in_progress per
                // trg_validate_trip_status_transition; completed and cancelled are terminal.
                const updateRes = await client.query(`
                    UPDATE trips
                    SET status = 'cancelled'
                    WHERE id = $1
                    RETURNING *;
                `, [tripId]);

                if (updateRes.rows.length === 0) {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                return sendJson(res, 200, { trip: updateRes.rows[0] });
            } catch (dbErr) {
                if (dbErr.code === 'P0001') {
                    const statusRes = await client.query('SELECT status FROM trips WHERE id = $1', [tripId]);
                    const currentStatus = statusRes.rows.length ? statusRes.rows[0].status : null;
                    if (currentStatus === 'completed') {
                        return sendError(res, 422, 'TRIP_ALREADY_COMPLETED', 'A completed trip cannot be cancelled.');
                    }
                    return sendError(res, 422, 'INVALID_STATE_TRANSITION', dbErr.message);
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
                return sendError(res, 400, 'INVALID_AMOUNT', 'amountMinor must be a positive integer expressed in minor units (e.g. cents).');
            }

            try {
                // Insert at the default 'pending' status, then settle it. The pending -> succeeded
                // move goes through trg_validate_payment_status_transition, which stamps paid_at.
                // Settled payments are immutable and UNIQUE(trip_id) allows exactly one per trip.
                await client.query('BEGIN');

                const insertRes = await client.query(`
                    INSERT INTO payments (trip_id, amount_minor, currency, provider_reference)
                    VALUES ($1, $2, $3, $4)
                    RETURNING id;
                `, [tripId, amountMinor, currency || 'USD', providerReference || null]);

                const settledRes = await client.query(`
                    UPDATE payments
                    SET status = 'succeeded'
                    WHERE id = $1
                    RETURNING *;
                `, [insertRes.rows[0].id]);

                await client.query('COMMIT');
                return sendJson(res, 201, { payment: settledRes.rows[0] });
            } catch (dbErr) {
                await client.query('ROLLBACK');

                if (dbErr.code === '23503') {
                    return sendError(res, 404, 'TRIP_NOT_FOUND', `Trip with id ${tripId} not found.`);
                }
                if (dbErr.code === '23505' && dbErr.constraint === 'payments_trip_id_key') {
                    return sendError(res, 409, 'PAYMENT_ALREADY_EXISTS', 'A payment already exists for this trip.', { tripId });
                }
                if (dbErr.code === '23505') {
                    return sendError(res, 409, 'DUPLICATE_PROVIDER_REFERENCE', 'That provider reference is already recorded against another payment.', { providerReference: providerReference || null });
                }
                if (dbErr.code === '23514') {
                    return sendError(res, 400, 'INVALID_PAYMENT', 'Payment rejected by database validation (amount must be positive, currency must be 3 characters).');
                }
                if (dbErr.code === 'P0001') {
                    if (String(dbErr.message).startsWith('Cannot capture payment')) {
                        return sendError(res, 422, 'TRIP_NOT_COMPLETED', dbErr.message, { tripId });
                    }
                    return sendError(res, 422, 'INVALID_STATE_TRANSITION', dbErr.message);
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
    console.log(`  RideFlow API Server running at http://localhost:${PORT}/api/v1`);
    console.log(`================================================================`);
    console.log(`  Health Check & Counts: GET http://localhost:${PORT}/api/v1/health`);
    console.log(`  List Riders          : GET http://localhost:${PORT}/api/v1/riders`);
    console.log(`  List Trips           : GET http://localhost:${PORT}/api/v1/trips`);
    console.log(`  Active Trip Check    : GET http://localhost:${PORT}/api/v1/riders/<id>/active-trip`);
    console.log(`================================================================\n`);
});
