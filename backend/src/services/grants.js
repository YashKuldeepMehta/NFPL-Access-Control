// Creating and ending grants, with the anti-escalation guardrails (Q8).
import { withTransaction } from '../db.js';
import { record } from './audit.js';
import { getRef } from './ref.js';
import { describeScope } from './describe.js';
import { requireCoverage, scopeOf, denial } from './authority.js';
import { NotFound, Conflict, ValidationError } from '../errors.js';

export async function createGrant(actor, input, ctx) {
  return withTransaction(async (db) => {
    const ref = await getRef();
    const grantee = (await db.query('SELECT * FROM users WHERE id = $1', [input.user_id])).rows[0];
    if (!grantee) throw new NotFound('User not found');
    const role = (await db.query('SELECT * FROM roles WHERE code = $1 AND retired_at IS NULL', [input.role_code])).rows[0];
    if (!role) throw new NotFound('Role not found');
    const scope = scopeOf(input);
    const entity = { type: 'user', id: String(grantee.id) };
    const attempted = `grant ${role.code} to ${grantee.name}`;
    const detailBase = { role: role.code, scope_text: describeScope(scope, ref) };

    // 1. no self-grant (also a DB CHECK)
    if (actor.id === grantee.id) throw denial(ctx, actor, 'SELF_GRANT', 'Nobody can grant access to themselves.', attempted, entity, detailBase);
    // 2. caller must hold access.grant, for THIS role, with a scope that contains the requested scope
    const authority = await requireCoverage(db, actor, 'access.grant', { target: scope, grantableRoleId: role.id }, ctx, attempted, entity);
    // 3. the role must be holdable by this kind of user, and client users stay inside their own client
    if (!role.actor_types.includes(grantee.type)) {
      throw denial(ctx, actor, 'ACTOR_TYPE_MISMATCH', `Role ${role.name} cannot be held by a ${grantee.type} user.`, attempted, entity, detailBase);
    }
    if (grantee.type === 'client' && scope.client_id !== grantee.client_id) {
      throw denial(ctx, actor, 'CLIENT_SCOPE_VIOLATION', 'A client user can only be limited to their own client.', attempted, entity, detailBase);
    }
    // 4. conflicting roles (e.g. Access Admin + Maker)
    const conflict = await db.query(
      `SELECT r.name FROM grants g JOIN roles r ON r.id = g.role_id
         JOIN role_conflicts c ON (c.role_a = $2 AND c.role_b = g.role_id) OR (c.role_b = $2 AND c.role_a = g.role_id)
        WHERE g.user_id = $1 AND (g.valid_to IS NULL OR g.valid_to > now())`, [grantee.id, role.id]);
    if (conflict.rowCount) {
      throw denial(ctx, actor, 'CONFLICTING_ROLE', `${grantee.name} already holds ${conflict.rows[0].name}, which conflicts with ${role.name}.`, attempted, entity, detailBase);
    }
    // 5. no duplicates; no back-dating (history must stay true)
    const dup = await db.query(
      `SELECT 1 FROM grants WHERE user_id = $1 AND role_id = $2 AND (valid_to IS NULL OR valid_to > now())
          AND client_id IS NOT DISTINCT FROM $3 AND branch_id IS NOT DISTINCT FROM $4
          AND direction IS NOT DISTINCT FROM $5 AND mode IS NOT DISTINCT FROM $6`,
      [grantee.id, role.id, scope.client_id, scope.branch_id, scope.direction, scope.mode]);
    if (dup.rowCount) throw new Conflict('DUPLICATE_GRANT', 'This person already holds an identical active grant.');
    if (input.valid_from) {
      const ok = await db.query(`SELECT $1::timestamptz >= now() - interval '5 minutes' AS ok`, [input.valid_from]);
      if (!ok.rows[0].ok) throw new ValidationError('Grants cannot be back-dated', [{ path: 'valid_from', message: 'must not be in the past' }]);
    }
    const { rows } = await db.query(
      `INSERT INTO grants (user_id, role_id, client_id, branch_id, direction, mode, valid_from, valid_to, reason, granted_by)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()), $8, $9, $10) RETURNING *`,
      [grantee.id, role.id, scope.client_id, scope.branch_id, scope.direction, scope.mode,
       input.valid_from ?? null, input.valid_to ?? null, input.reason, actor.id]);
    await record(db, { actorId: actor.id, event: 'grant.created', entityType: 'user', entityId: grantee.id, requestId: ctx.requestId,
      detail: { ...detailBase, grant_id: rows[0].id, user_id: grantee.id, user_name: grantee.name, reason: input.reason,
        valid_from: rows[0].valid_from, valid_to: rows[0].valid_to, authority_grant_id: authority.grant_id } });
    return rows[0];
  });
}

/** End one grant (shared by endGrant and disableUser). */
export async function endGrantRow(db, actor, grant, reason, ctx, attemptedLabel = 'end grant') {
  const ref = await getRef();
  const entity = { type: 'user', id: String(grant.user_id) };
  const scope = scopeOf(grant);
  if (actor.id === grant.user_id) throw denial(ctx, actor, 'SELF_REVOKE', 'Nobody can end their own grant; ask another admin.', attemptedLabel, entity);
  await requireCoverage(db, actor, 'access.revoke', { target: scope, grantableRoleId: grant.role_id }, ctx, attemptedLabel, entity);
  const { rows } = await db.query(
    `UPDATE grants SET valid_to = GREATEST(now(), valid_from), ended_by = $2, end_reason = $3 WHERE id = $1 RETURNING *`,
    [grant.id, actor.id, reason]);
  const names = (await db.query('SELECT u.name AS user_name, r.name AS role FROM users u, roles r WHERE u.id = $1 AND r.id = $2', [grant.user_id, grant.role_id])).rows[0];
  await record(db, { actorId: actor.id, event: 'grant.ended', entityType: 'user', entityId: grant.user_id, requestId: ctx.requestId,
    detail: { grant_id: grant.id, user_name: names.user_name, role: names.role, scope_text: describeScope(scope, ref), reason } });
  return rows[0];
}

export async function endGrant(actor, grantId, { reason }, ctx) {
  return withTransaction(async (db) => {
    const g = (await db.query('SELECT * FROM grants WHERE id = $1 FOR UPDATE', [grantId])).rows[0];
    if (!g) throw new NotFound('Grant not found');
    if (g.valid_to && new Date(g.valid_to) <= new Date()) throw new Conflict('GRANT_ALREADY_ENDED', 'This grant has already ended.');
    return endGrantRow(db, actor, g, reason, ctx);
  });
}
