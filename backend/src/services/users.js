import { withTransaction, pool } from '../db.js';
import { getRef } from './ref.js';
import { describeGrant } from './describe.js';
import { endGrantRow } from './grants.js';
import { record } from './audit.js';
import { NotFound, Conflict } from '../errors.js';
import { denial } from './authority.js';

export async function listUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.type, u.client_id, u.status,
            EXISTS (SELECT 1 FROM absences a WHERE a.user_id = u.id AND now() >= a.valid_from AND now() < a.valid_to) AS absent_now
       FROM users u ORDER BY u.id`);
  return rows;
}

/** Everything a person can do, in plain language ("Person A has role B for client C, branch D, ..."). */
export async function userAccess(userId) {
  const user = (await pool.query('SELECT id, name, email, type, status FROM users WHERE id = $1', [userId])).rows[0];
  if (!user) throw new NotFound('User not found');
  const ref = await getRef();
  const grants = (await pool.query(
    `SELECT g.*, u.name AS user_name, r.code AS role_code, r.name AS role_name, gb.name AS granted_by_name
       FROM grants g JOIN users u ON u.id = g.user_id JOIN roles r ON r.id = g.role_id JOIN users gb ON gb.id = g.granted_by
      WHERE g.user_id = $1 ORDER BY g.valid_from DESC, g.id DESC`, [userId])).rows
    .map((g) => ({ ...g, ...describeGrant(g, ref) }));
  const absences = (await pool.query(
    `SELECT a.*, u.name AS user_name, d.name AS delegate_name FROM absences a
       JOIN users u ON u.id = a.user_id LEFT JOIN users d ON d.id = a.delegate_id
      WHERE a.user_id = $1 OR a.delegate_id = $1 ORDER BY a.valid_from DESC`, [userId])).rows;
  return { user, grants, absences };
}

/** Someone leaves: every active/future grant ends and the account is disabled, in one transaction. */
export async function disableUser(actor, userId, { reason }, ctx) {
  return withTransaction(async (db) => {
    const u = (await db.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!u) throw new NotFound('User not found');
    if (u.disabled_at) throw new Conflict('ALREADY_DISABLED', 'This user is already disabled.');
    if (u.id === actor.id) throw denial(ctx, actor, 'SELF_REVOKE', 'Nobody can disable themselves.', 'disable user', { type: 'user', id: String(u.id) });
    const grants = (await db.query('SELECT * FROM grants WHERE user_id = $1 AND (valid_to IS NULL OR valid_to > now()) FOR UPDATE', [userId])).rows;
    for (const g of grants) await endGrantRow(db, actor, g, `User disabled: ${reason}`, ctx, `disable ${u.name}`);
    await db.query(`UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1`, [userId]);
    await record(db, { actorId: actor.id, event: 'user.disabled', entityType: 'user', entityId: userId, requestId: ctx.requestId,
      detail: { user_name: u.name, reason, grants_ended: grants.length } });
    return { user_id: userId, grants_ended: grants.length };
  });
}
