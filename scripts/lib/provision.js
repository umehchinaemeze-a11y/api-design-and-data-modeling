'use strict';

/*
 * Provisions the canonical UrbanGlide proof database.
 *
 * Both halves of the setup are reused verbatim from the TypeScript proof layer,
 * so there is exactly one schema definition (migrations/001_initial_schema.sql)
 * and exactly one dataset definition (src/seed.ts). The CommonJS verification
 * scripts in scripts/ used to carry a second, divergent copy of both under sql/.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { TARGET } = require('./target');

const REPO_ROOT = path.join(__dirname, '..', '..');

/* Invoked through the current Node binary rather than the .bin shim: the
 * repository path contains spaces, and a shell shim would split it. */
const TSX_CLI = require.resolve('tsx/cli', { paths: [REPO_ROOT] });

/* Applies the canonical migration. This is the exact SQL that src/migrate.ts
 * runs, and the exact SQL every file in evidence/ was captured against. */
async function applyMigration() {
    const migrationPath = path.join(REPO_ROOT, 'migrations', '001_initial_schema.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    const client = new Client({ connectionString: TARGET.connectionString });
    await client.connect();
    try {
        await client.query(sql);
    } finally {
        await client.end();
    }
}

/* Runs the canonical seed as a child process so the dataset definition stays in
 * src/seed.ts rather than being duplicated here. */
function applySeed() {
    const result = spawnSync(process.execPath, [TSX_CLI, path.join(REPO_ROOT, 'src', 'seed.ts')], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdio: ['ignore', 'ignore', 'inherit']
    });

    if (result.error) {
        throw new Error(`Could not execute the canonical seed (${TSX_CLI}): ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`Canonical seed src/seed.ts exited with status ${result.status}`);
    }
}

/* Full reset: canonical schema, then canonical deterministic dataset. */
async function provision() {
    await applyMigration();
    applySeed();
}

module.exports = { provision, applyMigration, applySeed, TARGET };
