import pg from 'pg';
import { config } from './config.js';

// bigint (int8) -> JS number. Our ids and counts are far below 2^53.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export function createPool(connectionString = config.databaseUrl) {
  const p = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000, // Neon may need a moment to wake from suspend
  });
  // Hosted Postgres (Neon) drops idle connections; without this handler the process would crash.
  p.on('error', (err) => console.error('[pg pool] idle client error:', err.message));
  return p;
}

export const pool = createPool();

export const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside one transaction. Everything (change + audit row) commits or rolls back together. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may already be gone */ }
    throw err;
  } finally {
    client.release();
  }
}
