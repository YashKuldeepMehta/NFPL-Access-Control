import { query } from '../db.js';

/** Append one audit row. `db` is a pool or a transaction client (so it commits atomically with the change). */
export async function record(db, e) {
  await db.query(
    `INSERT INTO audit_log (at, actor_id, on_behalf_of, event, entity_type, entity_id, job_id, outcome, reason_code, detail, request_id)
     VALUES (COALESCE($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [e.at ?? null, e.actorId ?? null, e.onBehalfOf ?? null, e.event, e.entityType, String(e.entityId ?? ''),
     e.jobId ?? null, e.outcome ?? 'allow', e.reasonCode ?? null, JSON.stringify(e.detail ?? {}), e.requestId ?? null],
  );
}

function summarise(r) {
  const who = r.actor_name ?? 'system';
  const behalf = r.on_behalf_of_name ? ` on behalf of ${r.on_behalf_of_name}` : '';
  const d = r.detail ?? {};
  switch (r.event) {
    case 'job.created': return `${who} created the job${behalf}.`;
    case 'job.transition': return `${who}${behalf} did ${d.action}: ${d.from_stage} -> ${d.to_stage}${d.reason ? ` (reason: ${d.reason})` : ''}.`;
    case 'job.updated': return `${who}${behalf} updated ${Object.keys(d.changes ?? {}).join(', ') || 'the job'}.`;
    case 'job.reassigned': return `${who}${behalf} assigned the job to ${d.owner_name ?? 'nobody'}.`;
    case 'job.admin_fix': return `${who} used an admin override: ${d.from_stage} -> ${d.to_stage} (reason: ${d.reason}).`;
    case 'approval.requested': return `${who} requested approval for ${d.action} (reason: ${d.reason}).`;
    case 'approval.decided': return `${who} ${d.decision}d the ${d.action} request.`;
    case 'access.denied': return `${who} was DENIED ${d.attempted ?? 'an action'}: ${r.reason_code}.`;
    case 'grant.created': return `${who} granted ${d.role} to ${d.user_name} for ${d.scope_text}.`;
    case 'grant.ended': return `${who} ended ${d.user_name}'s ${d.role} grant (${d.scope_text}).`;
    case 'absence.created': return `${who} recorded an absence for ${d.user_name}${d.delegate_name ? `, covered by ${d.delegate_name}` : ', with nobody covering'}.`;
    case 'absence.ended': return `${who} ended ${d.user_name}'s absence.`;
    case 'role.created': return `${who} created role ${d.code}.`;
    case 'role.permissions_changed': return `${who} changed permissions of role ${d.code}.`;
    case 'user.disabled': return `${who} disabled ${d.user_name}.`;
    default: return `${who}: ${r.event}`;
  }
}

const SELECT = `
  SELECT a.id, a.at, a.event, a.outcome, a.reason_code, a.entity_type, a.entity_id, a.job_id, a.detail,
         a.actor_id, u.name AS actor_name, a.on_behalf_of, ob.name AS on_behalf_of_name
  FROM audit_log a
  LEFT JOIN users u  ON u.id = a.actor_id
  LEFT JOIN users ob ON ob.id = a.on_behalf_of`;

export async function jobHistory(db, jobId) {
  const { rows } = await db.query(`${SELECT} WHERE a.job_id = $1 ORDER BY a.at, a.id`, [jobId]);
  return rows.map((r) => ({ ...r, summary: summarise(r) }));
}

export async function searchAudit(f) {
  const where = [];
  const params = [];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (f.actor) add('a.actor_id = ?', f.actor);
  if (f.event) add('a.event = ?', f.event);
  if (f.job) add('a.job_id = ?', f.job);
  if (f.outcome) add('a.outcome = ?', f.outcome);
  if (f.from) add('a.at >= ?::timestamptz', f.from);
  if (f.to) add('a.at <= ?::timestamptz', f.to);
  if (f.before_id) add('a.id < ?', f.before_id);
  params.push(f.limit);
  const { rows } = await query(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT $${params.length}`, params);
  return rows.map((r) => ({ ...r, summary: summarise(r) }));
}
