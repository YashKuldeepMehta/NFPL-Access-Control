// Authority checks for ACCESS MANAGEMENT operations (grants, absences, roles).
// Uses the person's own, currently valid, DIRECT grants only (an absent person has no authority).
import { Forbidden } from '../errors.js';

const DIMS = ['client_id', 'branch_id', 'direction', 'mode'];

/** Does an authority's scope fully contain the target scope? (NULL = all) */
export function scopeCovers(auth, target) {
  return DIMS.every((d) => auth[d] == null || auth[d] === (target[d] ?? null));
}

export const scopeOf = (o) => ({
  client_id: o.client_id ?? null, branch_id: o.branch_id ?? null, direction: o.direction ?? null, mode: o.mode ?? null,
});

/**
 * The caller's currently valid grants that carry `permission`.
 * With grantableRoleId: only grants whose role is allowed to hand out that role (role_grant_rights).
 */
export async function authorities(db, userId, permission, { grantableRoleId = null } = {}) {
  const { rows } = await db.query(
    `SELECT g.id AS grant_id, g.role_id, r.code AS role_code, g.client_id, g.branch_id, g.direction, g.mode
       FROM grants g
       JOIN users u ON u.id = g.user_id AND u.disabled_at IS NULL
       JOIN roles r ON r.id = g.role_id AND (r.retired_at IS NULL OR r.retired_at > now())
       JOIN role_permissions rp ON rp.role_id = g.role_id AND rp.permission_code = $2
                               AND now() >= rp.valid_from AND (rp.valid_to IS NULL OR now() < rp.valid_to)
      WHERE g.user_id = $1 AND now() >= g.valid_from AND (g.valid_to IS NULL OR now() < g.valid_to)
        AND NOT EXISTS (SELECT 1 FROM absences a WHERE a.user_id = g.user_id AND now() >= a.valid_from AND now() < a.valid_to)
        AND ($3::int IS NULL OR EXISTS (SELECT 1 FROM role_grant_rights x
                                         WHERE x.granter_role_id = g.role_id AND x.grantable_role_id = $3::int))`,
    [userId, permission, grantableRoleId]);
  return rows;
}

function denial(ctx, actor, code, message, attempted, entity = {}, detail = {}) {
  return new Forbidden(code, message, {
    audit: { actorId: actor.id, entityType: entity.type ?? 'access', entityId: entity.id ?? '', jobId: null,
      reasonCode: code, detail: { attempted, ...detail }, requestId: ctx.requestId },
  });
}
export { denial };

/** Caller must hold `permission` somewhere (any scope). Throws Forbidden otherwise. */
export async function requirePermission(db, actor, permission, ctx, attempted = permission) {
  const auths = await authorities(db, actor.id, permission);
  if (!auths.length) {
    throw denial(ctx, actor, 'MISSING_PERMISSION', `${actor.name} does not hold ${permission}.`, attempted);
  }
  return auths;
}

/** Caller must hold `permission` for a scope that covers `target`. Distinguishes "no right" from "scope too wide". */
export async function requireCoverage(db, actor, permission, { target, grantableRoleId = null }, ctx, attempted, entity) {
  const auths = await authorities(db, actor.id, permission, { grantableRoleId });
  if (!auths.length) {
    throw denial(ctx, actor, 'NO_AUTHORITY',
      `${actor.name} has no ${permission} right${grantableRoleId ? ' over this role' : ''}.`, attempted, entity);
  }
  const hit = auths.find((a) => scopeCovers(a, target));
  if (!hit) {
    throw denial(ctx, actor, 'SCOPE_WIDENING',
      `${actor.name}'s ${permission} right covers only part of the requested scope; access cannot be widened beyond one's own.`,
      attempted, entity);
  }
  return hit;
}
