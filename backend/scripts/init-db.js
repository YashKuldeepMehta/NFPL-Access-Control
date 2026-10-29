// Container start-up: wait for the database, apply migrations, and load the sample data
// only if the database is empty (so restarts never wipe anything). Set AUTO_SEED=false to skip seeding.
import { pool } from '../src/db.js';
import { runMigrations } from './migrate.js';
import { seed } from '../seed/seed.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDb(tries = 40) {
  for (let i = 1; i <= tries; i++) {
    try { await pool.query('SELECT 1'); return; }
    catch (e) {
      console.log(`[init] waiting for the database (${i}/${tries}): ${e.message}`);
      await sleep(3000);
    }
  }
  throw new Error('database never became reachable');
}

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  await waitForDb();
  const applied = await runMigrations(pool);
  console.log(applied.length ? `[init] migrations applied: ${applied.join(', ')}` : '[init] schema already up to date');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n === 0 && process.env.AUTO_SEED !== 'false') {
    console.log('[init] empty database: loading sample data ...');
    const c = await seed(pool);
    console.log(`[init] sample data loaded: ${c.users} users, ${c.grants} grants, ${c.jobs} jobs`);
  } else {
    console.log('[init] sample data not loaded (database already has users, or AUTO_SEED=false)');
  }
} catch (err) {
  console.error('[init] failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
