// Absence + delegation (Q4). While absent, a person's OWN access is suspended and a named
// delegate may use their delegable roles (Maker/Checker/Filer). Nobody covering => jobs show up as "unattended".
import { withTransaction } from '../db.js';
import { record } from './audit.js';
import { requireCoverage, scopeOf, denial } from './authority.js';
import { NotFound, Conflict, ValidationError } from '../errors.js';

export async function createAbsence(actor, input, ctx) {
  return withTransaction(async (db) => {
    const absent = (await db.query('SELECT * FROM users WHERE id = $1', [input.user_id])).rows[0];
    if (!absent) throw new NotFound('User not found');
    const delegate = input.delegate_id ? (await db.query('SELECT * FROM users WHERE id = $1', [input.delegate_id])).rows[0] : null;
    if (input.delegate_id && !delegate) throw new NotFound('Delegate not found');
    const entity = { type: 'user', id: String(absent.id) };
    const attempted = `record absence for ${absent.name}`;

    if (actor.id === absent.id) throw denial(ctx, actor, 'NO_AUTHORITY', 'Absences are recorded by a supervisor, not by the absent person.', attempted, entity);
    if (delegate && (delegate.type !== 'staff' || delegate.disabled_at)) {
      throw new ValidationError('The delegate must be an active staff member', [{ path: 'delegate_id', message: 'invalid delegate' }]);
    }
    // A supervisor may only suspend people whose ENTIRE access lies inside the supervisor's own scope.
    const theirGrants = (await db.query('SELECT * FROM grants WHERE user_id = $1 AND (valid_to IS NULL OR valid_to > now())', [absent.id])).rows;
    for (const g of theirGrants) await requireCoverage(db, actor, 'absence.manage', { target: scopeOf(g) }, ctx, attempted, entity);
    if (!theirGrants.length) await requireCoverage(db, actor, 'absence.manage', { target: {} }, ctx, attempted, entity);

    const ok = await db.query(`SELECT $1::timestamptz >= now() - interval '5 minutes' AS ok, $2::timestamptz > $1::timestamptz AS ordered`,
      [input.valid_from, input.valid_to]);
    if (!ok.rows[0].ok) throw new ValidationError('Absences cannot be back-dated', [{ path: 'valid_from', message: 'must not be in the past' }]);
    if (!ok.rows[0].ordered) throw new ValidationError('valid_to must be after valid_from', [{ path: 'valid_to', message: 'must be later' }]);
    const overlap = await db.query(
      `SELECT 1 FROM absences WHERE user_id = $1 AND valid_to > $2::timestamptz AND valid_from < $3::timestamptz`,
      [absent.id, input.valid_from, input.valid_to]);
    if (overlap.rowCount) throw new Conflict('ABSENCE_OVERLAP', 'This person already has an absence in that period.');

    const { rows } = await db.query(
      `INSERT INTO absences (user_id, delegate_id, valid_from, valid_to, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [absent.id, input.delegate_id ?? null, input.valid_from, input.valid_to, input.reason, actor.id]);
    await record(db, { actorId: actor.id, event: 'absence.created', entityType: 'user', entityId: absent.id, requestId: ctx.requestId,
      detail: { absence_id: rows[0].id, user_name: absent.name, delegate_name: delegate?.name ?? null, reason: input.reason,
        valid_from: rows[0].valid_from, valid_to: rows[0].valid_to } });
    return rows[0];
  });
}

export async function endAbsence(actor, absenceId, ctx) {
  return withTransaction(async (db) => {
    const a = (await db.query('SELECT a.*, u.name AS user_name FROM absences a JOIN users u ON u.id = a.user_id WHERE a.id = $1 FOR UPDATE', [absenceId])).rows[0];
    if (!a) throw new NotFound('Absence not found');
    const attempted = `end absence of ${a.user_name}`;
    const theirGrants = (await db.query('SELECT * FROM grants WHERE user_id = $1 AND (valid_to IS NULL OR valid_to > now())', [a.user_id])).rows;
    for (const g of theirGrants) await requireCoverage(db, actor, 'absence.manage', { target: scopeOf(g) }, ctx, attempted, { type: 'user', id: String(a.user_id) });
    const { rows } = await db.query(
      `UPDATE absences SET valid_to = LEAST(valid_to, GREATEST(now(), valid_from)), ended_by = $2 WHERE id = $1 RETURNING *`, [absenceId, actor.id]);
    await record(db, { actorId: actor.id, event: 'absence.ended', entityType: 'user', entityId: a.user_id, requestId: ctx.requestId,
      detail: { absence_id: absenceId, user_name: a.user_name } });
    return rows[0];
  });
}
