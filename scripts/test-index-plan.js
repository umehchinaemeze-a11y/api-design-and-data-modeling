const { Client } = require('pg');

async function testIndexPlan() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:15436/rideflow?sslmode=disable'
    });

    try {
        await client.connect();

        console.log('=== QUERY 1 with enable_seqscan = off ===');
        await client.query('SET enable_seqscan = OFF;');
        const q1 = `
            EXPLAIN (ANALYZE, BUFFERS, COSTS, VERBOSE)
            SELECT t.id, t.status, t.pickup_address, t.destination_address,
                   t.fare_amount_minor, t.currency, t.requested_at, t.accepted_at, t.started_at,
                   d.name AS driver_name, d.phone AS driver_phone,
                   v.make, v.model, v.registration_number
            FROM trips t
            LEFT JOIN drivers d ON t.driver_id = d.id
            LEFT JOIN vehicles v ON t.vehicle_id = v.id
            WHERE t.rider_id = '22222222-2222-4222-a222-222222222222'
              AND t.status IN ('requested', 'accepted', 'in_progress');
        `;
        const res1 = await client.query(q1);
        console.log(res1.rows.map(r => r['QUERY PLAN']).join('\n'));

        console.log('\n=== QUERY 2 with enable_seqscan = off ===');
        const q2 = `
            EXPLAIN (ANALYZE, BUFFERS, COSTS, VERBOSE)
            SELECT id, rider_id, pickup_address, destination_address,
                   fare_amount_minor, currency, requested_at
            FROM trips
            WHERE status = 'requested'
            ORDER BY requested_at ASC
            LIMIT 10;
        `;
        const res2 = await client.query(q2);
        console.log(res2.rows.map(r => r['QUERY PLAN']).join('\n'));

    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

testIndexPlan();
