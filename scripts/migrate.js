const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function migrate() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:15436/rideflow?sslmode=disable'
    });

    try {
        await client.connect();
        console.log('Connected to PostgreSQL database for migration.');

        const schemaSql = fs.readFileSync(path.join(__dirname, '../sql/schema.sql'), 'utf8');
        await client.query(schemaSql);
        console.log('Schema migration applied successfully (tables, enums, constraints, indexes, triggers).');
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

migrate();
