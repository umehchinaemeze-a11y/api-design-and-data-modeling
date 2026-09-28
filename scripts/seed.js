const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function seed() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:15436/rideflow?sslmode=disable'
    });

    try {
        await client.connect();
        console.log('Connected to PostgreSQL database for seeding.');

        const seedSql = fs.readFileSync(path.join(__dirname, '../sql/seed.sql'), 'utf8');
        await client.query(seedSql);
        console.log('Deterministic seed data inserted successfully.');
    } catch (err) {
        console.error('Seeding failed:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

seed();
