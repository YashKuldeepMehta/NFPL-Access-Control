import express from 'express';
import { pool } from './db.js';
import { requestContext, authenticate, errorHandler, wrap } from './middleware.js';
import routes from './routes/index.js';

export const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(requestContext);

// ---- public (no identity needed) ----
app.get('/health', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT now() AS db_time');
  res.json({ ok: true, db_time: rows[0].db_time });
}));

// Dev-only: lets the UI's user switcher list who you can "log in" as (identity is simulated).
app.get('/dev/users', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, type FROM users WHERE email <> 'bootstrap@nfpl.test' AND disabled_at IS NULL ORDER BY id`);
  res.json({ items: rows });
}));

// Dev-only: clients and branches for the UI's dropdowns (reference data, not sensitive).
app.get('/dev/ref', wrap(async (req, res) => {
  const [clients, branches] = await Promise.all([
    pool.query('SELECT id, code, name FROM clients ORDER BY id'), pool.query('SELECT id, code, name FROM branches ORDER BY id')]);
  res.json({ clients: clients.rows, branches: branches.rows });
}));

// ---- everything else needs an identity ----
app.use(authenticate, routes);
app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such route' } }));
app.use(errorHandler);
