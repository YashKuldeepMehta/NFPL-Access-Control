// Wipes and rebuilds the TEST database. Refuses to touch anything but TEST_DATABASE_URL.
import pg from 'pg';
import { pathToFileURL } from 'node:url';
import { runMigrations } from './migrate.js';

export async function resetDatabase(url) {
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    throw new Error('Refusing to reset: TEST_DATABASE_URL equals DATABASE_URL (that would wipe your real data)');
  }
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 30_000 });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    return await runMigrations(pool);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await import('dotenv/config');
  const applied = await resetDatabase(process.env.TEST_DATABASE_URL);
  console.log('Test database rebuilt. Applied:', applied.join(', '));
}
