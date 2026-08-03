import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { makeWorkerUtils } from 'graphile-worker';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function setupDatabase() {
  // Load .env file if it exists
  config();

  const connectionString =
    process.env.WORKFLOW_POSTGRES_URL ||
    process.env.DATABASE_URL ||
    'postgres://world:world@localhost:5432/world';

  console.log('🔧 Setting up database schema...');
  console.log(
    `📍 Connection: ${connectionString.replace(/^(\w+:\/\/)([^@]+)@/, '$1[redacted]@')}`
  );

  const pool = new Pool({ connectionString, max: 1 });
  const db = drizzle(pool);

  try {
    // Read the migration SQL file
    // The migrations are in src/drizzle/migrations, and this CLI is in dist/
    // So we need to go up one level from dist/ to reach src/
    const migrationsFolder = join(
      __dirname,
      '..',
      'src',
      'drizzle',
      'migrations'
    );
    console.log(`📂 Running migrations from: ${migrationsFolder}`);

    // Execute the migration
    await migrate(db, {
      migrationsFolder,
      migrationsTable: 'workflow_migrations',
      migrationsSchema: 'workflow_drizzle',
    });

    // Also bootstrap the graphile-worker schema. Without this, the first
    // process to call `world.start()` against a fresh DB is responsible
    // for running graphile-worker's `installSchema`, and concurrent
    // callers (e.g. the dev server + the test runner) can race on the
    // not-race-safe `CREATE SCHEMA IF NOT EXISTS` and fail with
    // `duplicate key value violates unique constraint
    // "pg_namespace_nspname_index"`. Running it here, single-process,
    // before any consumer starts means later `installSchema` calls find
    // the schema present and skip the racing DDL path entirely.
    console.log('📂 Bootstrapping graphile-worker schema...');
    const workerUtils = await makeWorkerUtils({ pgPool: pool });
    try {
      await workerUtils.migrate();
    } finally {
      await workerUtils.release();
    }

    console.log('✅ Database schema created successfully!');

    await pool.end();
    process.exit(0);
  } catch (error) {
    await pool.end().catch(() => {});
    console.error('❌ Failed to setup database:', error);
    process.exit(1);
  }
}

// Check if running as main module
if (import.meta.url === `file://${process.argv[1]}`) {
  setupDatabase();
}

export { setupDatabase };
