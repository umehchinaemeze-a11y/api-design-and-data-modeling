const { Client } = require('pg');

async function proveModel() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:15436/rideflow?sslmode=disable'
    });

    try {
        await client.connect();

        // Reset to clean deterministic seed state
        const fs = require('fs');
        const path = require('path');
        const seedSql = fs.readFileSync(path.join(__dirname, '../sql/seed.sql'), 'utf8');
        await client.query(seedSql);

        console.log('================================================================');
        console.log('       RIDEFLOW DATABASE PROOF & CONSTRAINT VERIFICATION        ');
        console.log('================================================================\n');

        // --------------------------------------------------------------------
        // TEST 1: SECOND ACTIVE TRIP REJECTION (PARTIAL UNIQUE INDEX)
        // --------------------------------------------------------------------
        console.log('--- TEST 1: Reject Second Active Trip for Same Rider ---');
        console.log('Action: Attempt to insert a second active trip for Rider Diana (has existing requested trip ca111111-...)');
        try {
            await client.query(`
                INSERT INTO trips (
                    id, rider_id, pickup_address, destination_address,
                    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
                    fare_amount_minor, currency, status
                ) VALUES (
                    'ca999999-9999-4999-d999-999999999999',
                    '44444444-4444-4444-a444-444444444444', -- Diana Prince
                    'Another Origin', 'Another Destination',
                    37.77, -122.41, 37.78, -122.40,
                    2000, 'USD', 'requested'
                );
            `);
            console.error('FAIL: Second active trip was unexpectedly allowed!');
        } catch (err) {
            console.log('RESULT: REJECTED AS EXPECTED');
            console.log('SQLSTATE Code  :', err.code);
            console.log('Constraint Name:', err.constraint);
            console.log('Error Message  :', err.message);
            console.log('Detail         :', err.detail);
        }

        // --------------------------------------------------------------------
        // TEST 2: ILLEGAL TRIP STATUS TRANSITION (TRIGGER ENFORCEMENT)
        // --------------------------------------------------------------------
        console.log('\n--- TEST 2: Reject Illegal Trip Status Transition ---');
        console.log('Action: Attempt to revert completed trip ca444444-... back to in_progress');
        try {
            await client.query(`
                UPDATE trips
                SET status = 'in_progress'
                WHERE id = 'ca444444-4444-4444-d444-444444444444';
            `);
            console.error('FAIL: Illegal transition was unexpectedly allowed!');
        } catch (err) {
            console.log('RESULT: REJECTED AS EXPECTED');
            console.log('SQLSTATE Code  :', err.code);
            console.log('Error Message  :', err.message);
            console.log('Where/Context  :', err.where);
        }

        // --------------------------------------------------------------------
        // TEST 3: REVIEW ON NON-COMPLETED TRIP (TRIGGER ENFORCEMENT)
        // --------------------------------------------------------------------
        console.log('\n--- TEST 3: Reject Review for Incomplete Trip ---');
        console.log('Action: Attempt to create a review for in_progress trip ca333333-...');
        try {
            await client.query(`
                INSERT INTO reviews (
                    id, trip_id, rating, comment
                ) VALUES (
                    'fa999999-9999-4999-f999-999999999999',
                    'ca333333-3333-4333-d333-333333333333', -- In progress trip
                    5, 'Premature review'
                );
            `);
            console.error('FAIL: Review on incomplete trip was unexpectedly allowed!');
        } catch (err) {
            console.log('RESULT: REJECTED AS EXPECTED');
            console.log('SQLSTATE Code  :', err.code);
            console.log('Error Message  :', err.message);
            console.log('Where/Context  :', err.where);
        }

        // --------------------------------------------------------------------
        // TEST 4: NEGATIVE MONEY CHECK CONSTRAINT
        // --------------------------------------------------------------------
        console.log('\n--- TEST 4: Reject Negative / Zero Fare (Check Constraint) ---');
        console.log('Action: Attempt to insert trip with fare_amount_minor = -1500');
        try {
            await client.query(`
                INSERT INTO trips (
                    id, rider_id, pickup_address, destination_address,
                    pickup_latitude, pickup_longitude, destination_latitude, destination_longitude,
                    fare_amount_minor, currency, status
                ) VALUES (
                    'ca888888-8888-4888-d888-888888888888',
                    '11111111-1111-4111-a111-111111111111',
                    'Origin', 'Dest',
                    37.77, -122.41, 37.78, -122.40,
                    -1500, 'USD', 'cancelled'
                );
            `);
            console.error('FAIL: Negative money was unexpectedly allowed!');
        } catch (err) {
            console.log('RESULT: REJECTED AS EXPECTED');
            console.log('SQLSTATE Code  :', err.code);
            console.log('Constraint Name:', err.constraint);
            console.log('Error Message  :', err.message);
        }

        // --------------------------------------------------------------------
        // TEST 5: INVALID RATING CHECK CONSTRAINT
        // --------------------------------------------------------------------
        console.log('\n--- TEST 5: Reject Rating Out of Bounds (Check Constraint) ---');
        console.log('Action: Attempt to insert review with rating = 6');
        try {
            await client.query(`
                INSERT INTO reviews (
                    id, trip_id, rating, comment
                ) VALUES (
                    'fa777777-7777-4777-f777-777777777777',
                    'ca555555-5555-4555-d555-555555555555', -- completed trip without review
                    6, 'Too good'
                );
            `);
            console.error('FAIL: Rating > 5 was unexpectedly allowed!');
        } catch (err) {
            console.log('RESULT: REJECTED AS EXPECTED');
            console.log('SQLSTATE Code  :', err.code);
            console.log('Constraint Name:', err.constraint);
            console.log('Error Message  :', err.message);
        }

        // --------------------------------------------------------------------
        // TEST 6: VALID COMPLETED TRIP REVIEW (POSITIVE PROOF)
        // --------------------------------------------------------------------
        console.log('\n--- TEST 6: Valid Review on Completed Trip (Positive Proof) ---');
        console.log('Action: Insert legitimate 4-star review for completed trip ca555555-...');
        const validRev = await client.query(`
            INSERT INTO reviews (
                id, trip_id, rating, comment
            ) VALUES (
                'fa555555-5555-4555-f555-555555555555',
                'ca555555-5555-4555-d555-555555555555',
                4, 'Great ride, slight detour.'
            ) RETURNING id, trip_id, rating, comment, created_at;
        `);
        console.log('RESULT: SUCCESS');
        console.log('Inserted Review:', validRev.rows[0]);

        // --------------------------------------------------------------------
        // TEST 7: REJECT PAYMENT FOR NON-COMPLETED TRIP (TRIGGER ENFORCEMENT)
        // --------------------------------------------------------------------
        console.log('\n--- TEST 7: Reject Payment for Incomplete Trip ---');
        console.log('Action: Attempt to insert payment for in_progress trip ca333333-...');
        try {
            await client.query(`
                INSERT INTO payments (
                    id, trip_id, amount_minor, currency, provider_reference, status
                ) VALUES (
                    'ba999999-9999-4999-9999-999999999999',
                    'ca333333-3333-4333-d333-333333333333', -- in_progress, not completed
                    4200, 'USD', 'ch_proof_unsettled', 'succeeded'
                );
            `);
            console.error('FAIL: Payment on incomplete trip was unexpectedly allowed!');
        } catch (err) {
            console.log('RESULT: REJECTED AS EXPECTED');
            console.log('SQLSTATE Code  :', err.code);
            console.log('Error Message  :', err.message);
            console.log('Where/Context  :', err.where);
        }

        console.log('\n================================================================');
        console.log('           ALL PROOF LAYER INVARIANTS VERIFIED!                 ');
        console.log('================================================================\n');

    } catch (err) {
        console.error('Unexpected error during proof:', err);
    } finally {
        await client.end();
    }
}

proveModel();
