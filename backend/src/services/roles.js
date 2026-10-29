// Roles are data (Q12): a new role can be created and edited at runtime with no deploy.
// Guardrails: dangerous permissions can never be put in a role via the API; built-in roles are locked.
import { withTransaction, pool } from '../db.js';
import { record } from './audit.js';
import { requirePermission, denial } from './authority.js';
import { NotFound, Conflict, ValidationError } from '../errors.js';

async function checkPermissions(db, codes, actor, ctx, attempted) {
  const { rows } = await db.query('SELECT code, is_dangerous FROM permissions WHERE code = ANY($1::text[])', [codes]);
  const unknown = codes.filter((c) => !rows.find((r) => r.code === c));
  if (unknown.length) throw new ValidationError(`Unknown permission(s): ${unknown.join(', ')}`, [{ path: 'permissions', message: 'unknown' }]);
  const bad = rows.filter((r) => r.is_dangerous).map((r) => r.code);
  if (bad.length) throw denial(ctx, actor, 'DANGEROUS_PERMISSION', `Dangerous permission(s) cannot be put in a role through the API: ${bad.join(', ')}`, attempted);
}

export async function listRoles() {
  const { rows } = await pool.query(
    `SELECT r.id, r.code, r.name, r.actor_types, r.delegable, r.is_system,
            COALESCE(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id AND now() >= rp.valid_from AND (rp.valid_to IS NULL OR now() < rp.valid_to)
      WHERE r.retired_at IS NULL GROUP BY r.id ORDER BY r.id`);
  return rows;
}

export async function createRole(actor, input, ctx) {
  return withTransaction(async (db) => {
    const auths = await requirePermission(db, actor, 'role.manage', ctx, 'create role');
    await checkPermissions(db, input.permissions, actor, ctx, `create role ${input.code}`);
    if ((await db.query('SELECT 1 FROM roles WHERE code = $1', [input.code])).rowCount) throw new Conflict('ROLE_EXISTS', 'A role with this code already exists.');
    const role = (await db.query(
      `INSERT INTO roles (code, name, actor_types, delegable, is_system) VALUES ($1,$2,$3,$4,false) RETURNING *`,
      [input.code, input.name, input.actor_types, input.delegable])).rows[0];
    for (const p of input.permissions) {
      await db.query('INSERT INTO role_permissions (role_id, permission_code, changed_by) VALUES ($1,$2,$3)', [role.id, p, actor.id]);
    }
    // The creator's own role may hand out the new role (it contains no dangerous permission, so this is safe).
    for (const roleId of [...new Set(auths.map((a) => a.role_id))]) {
      await db.query('INSERT INTO role_grant_rights (granter_role_id, grantable_role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [roleId, role.id]);
    }
    await record(db, { actorId: actor.id, event: 'role.created', entityType: 'role', entityId: role.id, requestId: ctx.requestId,
      detail: { code: role.code, permissions: input.permissions } });
    return { ...role, permissions: input.permissions };
  });
}

export async function setRolePermissions(actor, roleId, { permissions, reason }, ctx) {
  return withTransaction(async (db) => {
    await requirePermission(db, actor, 'role.manage', ctx, 'edit role');
    const role = (await db.query('SELECT * FROM roles WHERE id = $1 FOR UPDATE', [roleId])).rows[0];
    if (!role) throw new NotFound('Role not found');
    if (role.is_system) throw denial(ctx, actor, 'SYSTEM_ROLE_LOCKED', 'Built-in roles cannot be edited through the API.', `edit role ${role.code}`);
    await checkPermissions(db, permissions, actor, ctx, `edit role ${role.code}`);
    const current = (await db.query(
      `SELECT permission_code FROM role_permissions WHERE role_id = $1 AND valid_to IS NULL`, [roleId])).rows.map((r) => r.permission_code);
    const added = permissions.filter((p) => !current.includes(p));
    const removed = current.filter((p) => !permissions.includes(p));
    for (const p of added) await db.query('INSERT INTO role_permissions (role_id, permission_code, changed_by) VALUES ($1,$2,$3)', [roleId, p, actor.id]);
    if (removed.length) {
      await db.query(`UPDATE role_permissions SET valid_to = now() WHERE role_id = $1 AND permission_code = ANY($2::text[]) AND valid_to IS NULL`, [roleId, removed]);
    }
    await record(db, { actorId: actor.id, event: 'role.permissions_changed', entityType: 'role', entityId: roleId, requestId: ctx.requestId,
      detail: { code: role.code, added, removed, reason } });
    return { role_id: roleId, added, removed };
  });
}
