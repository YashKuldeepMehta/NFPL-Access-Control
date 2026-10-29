// Job reads and writes. Every write: lock the job row, re-run the SAME decision engine inside the
// transaction, change the job, and write the audit row in that same transaction.
import { withTransaction, pool } from '../db.js';
import { decide, jobAccess } from '../engine/decision.js';
import { visibleJobsPage } from '../engine/worklist.js';
import { record } from './audit.js';
import { redactJob } from './redaction.js';
import { Forbidden, NotFound, ValidationError } from '../errors.js';

const RANK = { confirmed: 0, reopened: 0, prepared: 1, checked: 2 };

export function denyDecision(ctx, actor, decision, job, attempted) {
  return new Forbidden(decision.reason_code, decision.summary, {
    decision,
    audit: {
      actorId: actor.id, jobId: job?.id ?? null, entityType: 'job', entityId: String(job?.id ?? ''),
      reasonCode: decision.reason_code, requestId: ctx.requestId,
      detail: { attempted, summary: decision.summary, checks: decision.checks },
    },
  });
}

export async function loadJob(db, id, { lock = false } = {}) {
  const { rows } = await db.query(`SELECT * FROM jobs WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new NotFound('Job not found');
  return rows[0];
}

const afterState = (j) => ({
  stage: j.stage, prepared_by: j.prepared_by, checked_by: j.checked_by, filed_by: j.filed_by, owner_id: j.owner_id,
});
const behalf = (d, actor) => (d.grant?.delegated && d.grant.via_user !== actor.id ? d.grant.via_user : null);

// ---------- reads ----------
export async function listJobs(actor, q) {
  const page = await visibleJobsPage(pool, actor.id, {
    cursor: q.cursor, limit: q.limit, stage: q.stage ?? null, clientId: q.client_id ?? null, branchId: q.branch_id ?? null,
  });
  return { items: page.items.map((r) => redactJob(r, r.can_view_internal)), next_cursor: page.next_cursor };
}

/** 404 (not 403) when the caller may not see the job, so existence is not leaked. */
export async function getJob(actor, id) {
  const job = await loadJob(pool, id);
  const access = await jobAccess(pool, { userId: actor.id, job });
  if (!access.can_view) throw new NotFound('Job not found');
  return { job: redactJob(job, access.can_view_internal), access };
}

// ---------- writes ----------
export async function createJob(actor, input, ctx) {
  return withTransaction(async (db) => {
    const target = { ...input, stage: null };
    const d = await decide(db, { userId: actor.id, action: 'job.create', job: target });
    if (!d.allowed) throw denyDecision(ctx, actor, d, null, 'job.create');
    const { rows } = await db.query(
      `INSERT INTO jobs (job_no, client_id, branch_id, direction, mode, stage, internal_notes, customs_ref, created_by)
       VALUES ('NF-' || lpad(nextval('job_no_seq')::text, 6, '0'), $1, $2, $3, $4, 'confirmed', $5, $6, $7) RETURNING *`,
      [input.client_id, input.branch_id, input.direction, input.mode, input.internal_notes ?? null, input.customs_ref ?? null, actor.id]);
    const job = rows[0];
    await record(db, {
      actorId: actor.id, onBehalfOf: behalf(d, actor), event: 'job.created', entityType: 'job', entityId: job.id, jobId: job.id,
      reasonCode: d.reason_code, requestId: ctx.requestId,
      detail: { after: afterState(job), grant_id: d.grant.grant_id, role: d.grant.role },
    });
    return job;
  });
}

export async function updateJob(actor, id, patch, ctx) {
  return withTransaction(async (db) => {
    const job = await loadJob(db, id, { lock: true });
    const d = await decide(db, { userId: actor.id, action: 'job.update', job });
    if (!d.allowed) throw denyDecision(ctx, actor, d, job, 'job.update');
    const changes = {};
    for (const k of Object.keys(patch)) if (patch[k] !== job[k]) changes[k] = { from: job[k], to: patch[k] };
    const { rows } = await db.query(
      `UPDATE jobs SET internal_notes = $2, customs_ref = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, 'internal_notes' in patch ? patch.internal_notes : job.internal_notes, 'customs_ref' in patch ? patch.customs_ref : job.customs_ref]);
    await record(db, {
      actorId: actor.id, onBehalfOf: behalf(d, actor), event: 'job.updated', entityType: 'job', entityId: id, jobId: id,
      reasonCode: d.reason_code, requestId: ctx.requestId, detail: { changes, grant_id: d.grant.grant_id },
    });
    return rows[0];
  });
}

/** Stage-changing actions: prepare, check, file, cancel, cancel_filed, reopen. */
export async function performAction(actor, jobId, action, { reason, approval_id }, ctx) {
  return withTransaction(async (db) => {
    const known = await db.query('SELECT 1 FROM job_transitions WHERE action = $1 LIMIT 1', [action]);
    if (!known.rowCount) throw new ValidationError(`'${action}' is not a stage-changing action`, []);

    const job = await loadJob(db, jobId, { lock: true });
    const d = await decide(db, { userId: actor.id, action, job });
    if (!d.allowed) throw denyDecision(ctx, actor, d, job, action);

    let approval = null;
    if (d.requires.approval) {
      const found = approval_id
        ? (await db.query('SELECT *, (expires_at > now()) AS live FROM approval_requests WHERE id = $1 FOR UPDATE', [approval_id])).rows[0]
        : null;
      const valid = found && found.job_id === job.id && found.action === action && found.status === 'approved'
        && found.requested_by === actor.id && found.live;
      if (!valid) {
        const code = approval_id ? 'APPROVAL_INVALID' : 'APPROVAL_REQUIRED';
        throw new Forbidden(code, approval_id
          ? 'That approval is missing, expired, already used, not approved, or not yours.'
          : `${action} on a ${job.stage} job needs a second person\'s approval first.`, {
          audit: { actorId: actor.id, jobId: job.id, entityType: 'job', entityId: String(job.id), reasonCode: code,
            requestId: ctx.requestId, detail: { attempted: action, approval_id: approval_id ?? null } },
        });
      }
      approval = found;
    }
    const why = reason ?? approval?.reason;
    if (d.requires.reason && !why) throw new ValidationError('A reason is required for this action', [{ path: 'reason', message: 'required' }]);

    const after = { ...afterState(job), stage: d.to_stage, owner_id: null };
    if (action === 'job.prepare') after.prepared_by = actor.id;
    if (action === 'job.check') after.checked_by = actor.id;
    if (action === 'job.file') after.filed_by = actor.id;
    if (action === 'job.reopen') { after.checked_by = null; after.filed_by = null; }

    const { rows } = await db.query(
      `UPDATE jobs SET stage = $2, prepared_by = $3, checked_by = $4, filed_by = $5, owner_id = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`, [job.id, after.stage, after.prepared_by, after.checked_by, after.filed_by]);
    if (approval) await db.query(`UPDATE approval_requests SET status = 'executed' WHERE id = $1`, [approval.id]);

    await record(db, {
      actorId: actor.id, onBehalfOf: behalf(d, actor), event: 'job.transition', entityType: 'job', entityId: job.id, jobId: job.id,
      reasonCode: d.reason_code, requestId: ctx.requestId,
      detail: { action, from_stage: job.stage, to_stage: after.stage, reason: why ?? null, approval_id: approval?.id ?? null,
        grant_id: d.grant.grant_id, role: d.grant.role, after },
    });
    return rows[0];
  });
}

export async function reassignJob(actor, jobId, { owner_id, reason }, ctx) {
  return withTransaction(async (db) => {
    const job = await loadJob(db, jobId, { lock: true });
    const d = await decide(db, { userId: actor.id, action: 'job.reassign', job });
    if (!d.allowed) throw denyDecision(ctx, actor, d, job, 'job.reassign');

    let ownerName = null;
    if (owner_id != null) {
      const u = (await db.query('SELECT id, name FROM users WHERE id = $1', [owner_id])).rows[0];
      if (!u) throw new NotFound('Assignee not found');
      ownerName = u.name;
      // The assignee must be able to do the NEXT step, otherwise we would just create an unattended job.
      const next = (await db.query('SELECT action FROM job_transitions WHERE from_stage = $1 AND in_worklist LIMIT 1', [job.stage])).rows[0];
      const nd = next ? await decide(db, { userId: owner_id, action: next.action, job }) : null;
      if (!nd?.allowed) {
        throw new Forbidden('ASSIGNEE_NOT_ELIGIBLE', `${u.name} could not perform the next step on this job: ${nd?.summary ?? 'no next step'}`, {
          decision: nd ?? undefined,
          audit: { actorId: actor.id, jobId: job.id, entityType: 'job', entityId: String(job.id), reasonCode: 'ASSIGNEE_NOT_ELIGIBLE',
            requestId: ctx.requestId, detail: { attempted: 'job.reassign', owner_id } },
        });
      }
    }
    const { rows } = await db.query('UPDATE jobs SET owner_id = $2, updated_at = now() WHERE id = $1 RETURNING *', [jobId, owner_id]);
    await record(db, {
      actorId: actor.id, onBehalfOf: behalf(d, actor), event: 'job.reassigned', entityType: 'job', entityId: jobId, jobId,
      reasonCode: d.reason_code, requestId: ctx.requestId,
      detail: { from_owner_id: job.owner_id, owner_id, owner_name: ownerName, reason: reason ?? null },
    });
    return rows[0];
  });
}

/** Audited override: a stuck job can be sent BACK to an earlier stage. Never forward, never when filed/cancelled. */
export async function adminFix(actor, jobId, { to_stage, reason }, ctx) {
  return withTransaction(async (db) => {
    const job = await loadJob(db, jobId, { lock: true });
    const d = await decide(db, { userId: actor.id, action: 'job.admin_fix', job });
    if (!d.allowed) throw denyDecision(ctx, actor, d, job, 'job.admin_fix');
    if (!(RANK[to_stage] < RANK[job.stage])) {
      throw new Forbidden('ADMIN_CANNOT_ADVANCE', `An admin override may only send a job back (${job.stage} -> ${to_stage} is not backwards).`, {
        audit: { actorId: actor.id, jobId, entityType: 'job', entityId: String(jobId), reasonCode: 'ADMIN_CANNOT_ADVANCE',
          requestId: ctx.requestId, detail: { attempted: 'job.admin_fix', from_stage: job.stage, to_stage } },
      });
    }
    const after = { ...afterState(job), stage: to_stage, owner_id: null };
    if (to_stage === 'confirmed') after.prepared_by = null;
    if (to_stage !== 'checked') { after.checked_by = null; after.filed_by = null; }
    const { rows } = await db.query(
      `UPDATE jobs SET stage = $2, prepared_by = $3, checked_by = $4, filed_by = $5, owner_id = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`, [jobId, to_stage, after.prepared_by, after.checked_by, after.filed_by]);
    await record(db, {
      actorId: actor.id, event: 'job.admin_fix', entityType: 'job', entityId: jobId, jobId, reasonCode: d.reason_code,
      requestId: ctx.requestId, detail: { override: true, from_stage: job.stage, to_stage, reason, grant_id: d.grant.grant_id, after },
    });
    return rows[0];
  });
}
