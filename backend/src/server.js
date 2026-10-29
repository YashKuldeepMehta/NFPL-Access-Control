import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
try {
  await pool.query('SELECT 1'); // also wakes a suspended Neon compute
} catch (err) {
  console.error('Cannot reach the database:', err.message);
  process.exit(1);
}
app.listen(config.port, () => console.log(`Access Control Service listening on http://localhost:${config.port}`));
