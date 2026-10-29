import request from 'supertest';
import { app } from '../../src/app.js';
import { pool } from '../../src/db.js';
import { createJobWithHistory } from '../../seed/lib.js';

export { pool };

/** Call the API as a seeded (or test-created) person, e.g. as('ravi').get('/me') */
export const as = (key) => {
  const set = (r) => r.set('X-User-Email', `${key}@nfpl.test`);
  return {
    get: (u) => set(request(app).get(u)),
    post: (u, b = {}) => set(request(app).post(u)).send(b),
    patch: (u, b = {}) => set(request(app).patch(u)).send(b),
    put: (u, b = {}) => set(request(app).put(u)).send(b),
  };
};
export const anon = () => request(app);

export const uid = async (key) => (await pool.query('SELECT id FROM users WHERE email = $1', [`${key}@nfpl.test`])).rows[0].id;
export const clientId = async (code) => (await pool.query('SELECT id FROM clients WHERE code = $1', [code])).rows[0].id;
export const branchId = async (code) => (await pool.query('SELECT id FROM branches WHERE code = $1', [code])).rows[0].id;
export const plant = async (note) => (await pool.query('SELECT * FROM jobs WHERE internal_notes = $1', [`PLANT:${note}`])).rows[0];
export const getJob = async (id) => (await pool.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];

let counter = 0;
/** A fresh user (so tests never disturb the seeded people). Returns { id, key }. */
export async function newUser({ type = 'staff', client } = {}) {
  const key = `t${Date.now().toString(36)}${counter++}`;
  const r = await pool.query('INSERT INTO users (name, email, type, client_id) VALUES ($1,$2,$3,$4) RETURNING id',
    [`Test ${key}`, `${key}@nfpl.test`, type, client ? await clientId(client) : null]);
  return { id: r.rows[0].id, key };
}

/** Insert a grant directly (test set-up only; the API forbids back-dating). */
export async function grant(userId, roleCode, { client, branch, direction, mode, from, to } = {}) {
  const boot = await uid('bootstrap');
  const r = await pool.query(
    `INSERT INTO grants (user_id, role_id, client_id, branch_id, direction, mode, valid_from, valid_to, reason, granted_by)
     VALUES ($1,(SELECT id FROM roles WHERE code=$2),$3,$4,$5,$6, COALESCE($7::timestamptz, now() - interval '1 day'), $8, 'test setup', $9) RETURNING id`,
    [userId, roleCode, client ? await clientId(client) : null, branch ? await branchId(branch) : null, direction ?? null, mode ?? null,
     from ?? null, to ?? null, boot]);
  return r.rows[0].id;
}

/** Create a job (with audit history). steps: [[action, userKey|userId, hoursAgo], ...] oldest first. */
export async function mkJob({ client = 'ACME', branch = 'MUM', direction = 'import', mode = 'air', steps = [], owner } = {}) {
  const hours = (h) => new Date(Date.now() - h * 3_600_000);
  return createJobWithHistory(pool, {
    client_id: await clientId(client), branch_id: await branchId(branch), direction, mode,
    created_by: await uid('parser'), created_at: hours(100), internal_notes: 'test job',
    steps: await Promise.all(steps.map(async ([action, who, h]) => ({ action, actor: typeof who === 'number' ? who : await uid(who), at: hours(h) }))),
    owner_id: owner ?? null, owner_set_at: hours(1),
  });
}
export const FILED = [['job.prepare', 'asha', 90], ['job.check', 'ravi', 80], ['job.file', 'neha', 70]];
