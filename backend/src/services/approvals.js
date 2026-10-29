// Two-person rule for cancelling a FILED job and for reopening a closed one.
// Step 1: a Controller requests (reason mandatory). Step 2: a DIFFERENT Controller approves.
// Step 3: the requester performs the action with approval_id (single use, expires in 24h).
import { withTransaction, pool } from '../db.js';
import { decide } from '../engine/decision.js';
import { loadJob, denyDecision } from './jobs.js';
import { record } from './audit.js';
import { Forbidden, NotFound, Conflict, ValidationError } from '../errors.js';

export async function requestApproval(actor, jobId, { action, reason }, ctx) {
  return withTransaction(async (db) => {
    const t = await db.query('SELECT 1 FROM job_transitions WHERE action = $1 AND requires_approval LIMIT 1', [action]);
    if (!t.rowCount) throw new ValidationError(`'${action}' does not use approvals`, []);
    const job = await loadJob(db, jobId, { lock: true });
    const d = await decide(db, { userId: actor.id, action, job });
    if (!d.allowed) throw denyDecision(ctx, actor, d, job, `request approval for ${action}`);

    await db.query(`UPDATE approval_requests SET status = 'expired'
                     WHERE job_id = $1 AND action = $2 AND status = 'pending' AND expires_at <= now()`, [jobId, action]);
    const dup = await db.query(`SELECT 1 FROM approval_requests WHERE job_id = $1 AND action = $2 AND status = 'pending'`, [jobId, action]);
    if (dup.rowCount) throw new Conflict('APPROVAL_ALREADY_PENDING', 'There is already a pending request for this action on this job.');

    const { rows } = await db.query(
      `INSERT INTO approval_requests (job_id, action, requested_by, reason, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '24 hours') RETURNING *`, [jobId, action, actor.id, reason]);
    await record(db, { actorId: actor.id, event: 'approval.requested', entityType: 'approval', entityId: rows[0].id, jobId,
      requestId: ctx.requestId, detail: { action, reason, approval_id: rows[0].id } });
    return rows[0];
  });
}

export async function decideApproval(actor, approvalId, { decision, note }, ctx) {
  const probe = await pool.query('SELECT job_id FROM approval_requests WHERE id = $1', [approvalId]);
  if (!probe.rows[0]) throw new NotFound('Approval request not found');
  return withTransaction(async (db) => {
    const job = await loadJob(db, probe.rows[0].job_id, { lock: true }); // always lock the job first (no deadlocks)
    const ap = (await db.query('SELECT *, (expires_at > now()) AS live FROM approval_requests WHERE id = $1 FOR UPDATE', [approvalId])).rows[0];
    const fail = (code, msg) => new Forbidden(code, msg, { audit: { actorId: actor.id, jobId: job.id, entityType: 'approval',
      entityId: String(approvalId), reasonCode: code, requestId: ctx.requestId, detail: { attempted: 'decide approval' } } });

    if (ap.status !== 'pending') throw new Conflict('APPROVAL_NOT_PENDING', `This request is already ${ap.status}.`);
    if (!ap.live) throw new Conflict('APPROVAL_EXPIRED', 'This request has expired; ask for a new one.');
    if (ap.requested_by === actor.id) throw fail('SELF_APPROVAL', 'Nobody can approve their own request.');
    const d = await decide(db, { userId: actor.id, action: 'job.approve_dangerous', job });
    if (!d.allowed) throw denyDecision(ctx, actor, d, job, 'approve dangerous action');
    const still = await db.query('SELECT 1 FROM job_transitions WHERE action = $1 AND from_stage = $2', [ap.action, job.stage]);
    if (!still.rowCount) throw new Conflict('JOB_CHANGED', `The job is now '${job.stage}', so ${ap.action} no longer applies.`);

    const status = decision === 'approve' ? 'approved' : 'rejected';
    const { rows } = await db.query(
      `UPDATE approval_requests SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING *`,
      [approvalId, status, actor.id, note ?? null]);
    await record(db, { actorId: actor.id, event: 'approval.decided', entityType: 'approval', entityId: approvalId, jobId: job.id,
      requestId: ctx.requestId, detail: { action: ap.action, decision, note: note ?? null, requested_by: ap.requested_by } });
    return rows[0];
  });
}
