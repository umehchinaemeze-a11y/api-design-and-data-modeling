'use strict';

/*
 * Single source of truth for which PostgreSQL instance the proof targets.
 *
 * These defaults mirror docker-compose.yml exactly, so `docker compose up -d`
 * followed by any script in this repository lands on the same database that
 * README section 27 tells a reviewer to create. Previously the CommonJS
 * scripts defaulted to a second, separately-created `rideflow` database whose
 * schema and index names did not match the documented migration.
 */

const TARGET = {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 15436),
    user: process.env.PGUSER || 'urbanglider',
    password: process.env.PGPASSWORD || 'glidepassword',
    database: process.env.PGDATABASE || 'urbanglide_db'
};

if (process.env.DATABASE_URL) {
    TARGET.connectionString = process.env.DATABASE_URL;
} else {
    TARGET.connectionString =
        `postgresql://${TARGET.user}:${TARGET.password}@${TARGET.host}:${TARGET.port}/${TARGET.database}?sslmode=disable`;
}

/* The canonical schema is migrations/001_initial_schema.sql, the same file
 * src/migrate.ts applies and the same one the evidence in evidence/ was
 * captured from. There is deliberately no second schema definition. */
TARGET.migrationFile = 'migrations/001_initial_schema.sql';

module.exports = { TARGET };
