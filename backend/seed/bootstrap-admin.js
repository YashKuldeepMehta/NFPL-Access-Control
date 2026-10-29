// The ONLY way to create the first Access Admin / Controllers (nobody can grant these through the API).
// Usage: npm run bootstrap-admin -- --name "Jane Doe" --email jane@company.com --role access_admin
import { pool } from '../src/db.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : null; };
const name = arg('name'); const email = arg('email'); const role = arg('role') ?? 'access_admin';

try {
  if (!name || !email) throw new Error('Usage: npm run bootstrap-admin -- --name "Jane Doe" --email jane@x.com [--role access_admin|controller]');
  if (!['access_admin', 'controller'].includes(role)) throw new Error('--role must be access_admin or controller');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    let boot = (await db.query(`SELECT id FROM users WHERE email = 'bootstrap@nfpl.test'`)).rows[0];
    if (!boot) boot = (await db.query(`INSERT INTO users (name, email, type) VALUES ('System Bootstrap','bootstrap@nfpl.test','system') RETURNING id`)).rows[0];
    let user = (await db.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
    if (!user) user = (await db.query(`INSERT INTO users (name, email, type) VALUES ($1,$2,'staff') RETURNING id`, [name, email])).rows[0];
    const g = (await db.query(
      `INSERT INTO grants (user_id, role_id, reason, granted_by) VALUES ($1,(SELECT id FROM roles WHERE code=$2),'Created by bootstrap CLI',$3) RETURNING id`,
      [user.id, role, boot.id])).rows[0];
    await db.query(`INSERT INTO audit_log (actor_id, event, entity_type, entity_id, outcome, detail)
                    VALUES ($1,'grant.created','user',$2,'allow',$3::jsonb)`,
      [boot.id, String(user.id), JSON.stringify({ via: 'bootstrap-cli', role, user_name: name, grant_id: g.id })]);
    await db.query('COMMIT');
    console.log(`Created ${role} grant #${g.id} for ${name} <${email}> (user id ${user.id}).`);
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
