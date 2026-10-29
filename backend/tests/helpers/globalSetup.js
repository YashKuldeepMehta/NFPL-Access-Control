import 'dotenv/config';
import pg from 'pg';
import { resetDatabase } from '../../scripts/reset-test-db.js';
import { seed } from '../../seed/seed.js';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  await resetDatabase(url);                         // refuses to run against DATABASE_URL
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try { await seed(pool); } finally { await pool.end(); }
}
