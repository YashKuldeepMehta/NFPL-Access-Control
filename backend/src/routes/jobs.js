import { Router } from 'express';
import { pool } from '../db.js';
import { wrap } from '../middleware.js';
import { parse, schemas } from '../validation.js';
import * as jobs from '../services/jobs.js';
import { requestApproval } from '../services/approvals.js';
import { decide, jobAccess } from '../engine/decision.js';
import { whoCouldAct } from '../engine/explain.js';
import { jobHistory } from '../services/audit.js';
import { requirePermission } from '../services/authority.js';
import { NotFound } from '../errors.js';

const r = Router();
const jobId = (req) => parse(schemas.id, req.params.id);

r.get('/jobs', wrap(async (req, res) => {
  res.json(await jobs.listJobs(req.user, parse(schemas.jobsQuery, req.query)));
}));

r.post('/jobs', wrap(async (req, res) => {
  res.status(201).json(await jobs.createJob(req.user, parse(schemas.createJob, req.body), req.ctx));
}));

r.get('/jobs/:id', wrap(async (req, res) => {
  res.json(await jobs.getJob(req.user, jobId(req)));
}));

r.patch('/jobs/:id', wrap(async (req, res) => {
  res.json(await jobs.updateJob(req.user, jobId(req), parse(schemas.updateJob, req.body), req.ctx));
}));

// prepare | check | file | cancel | cancel_filed | reopen  (e.g. POST /jobs/12/actions/job.check)
r.post('/jobs/:id/actions/:action', wrap(async (req, res) => {
  const body = parse(schemas.actionBody, req.body ?? {});
  res.json(await jobs.performAction(req.user, jobId(req), req.params.action, body, req.ctx));
}));

r.post('/jobs/:id/reassign', wrap(async (req, res) => {
  res.json(await jobs.reassignJob(req.user, jobId(req), parse(schemas.reassign, req.body), req.ctx));
}));

r.post('/jobs/:id/admin-fix', wrap(async (req, res) => {
  res.json(await jobs.adminFix(req.user, jobId(req), parse(schemas.adminFix, req.body), req.ctx));
}));

r.post('/jobs/:id/approvals', wrap(async (req, res) => {
  res.status(201).json(await requestApproval(req.user, jobId(req), parse(schemas.approvalRequest, req.body), req.ctx));
}));

// What can I do on this job? (drives the UI buttons)
r.get('/jobs/:id/actions', wrap(async (req, res) => {
  const job = await jobs.loadJob(pool, jobId(req));
  const access = await jobAccess(pool, { userId: req.user.id, job });
  if (!access.can_view) throw new NotFound('Job not found');
  res.json({ stage: job.stage, actions: access.actions });
}));

// The job's audit trail.
r.get('/jobs/:id/history', wrap(async (req, res) => {
  const job = await jobs.loadJob(pool, jobId(req));
  const access = await jobAccess(pool, { userId: req.user.id, job });
  if (!access.can_view) throw new NotFound('Job not found');
  if (!access.can_view_history) {
    throw jobs.denyDecision(req.ctx, req.user, await decide(pool, { userId: req.user.id, action: 'job.view_history', job }), job, 'view history');
  }
  res.json({ job_id: job.id, job_no: job.job_no, events: await jobHistory(pool, job.id) });
}));

// Approval requests for this job (same visibility as its history).
r.get('/jobs/:id/approvals', wrap(async (req, res) => {
  const job = await jobs.loadJob(pool, jobId(req));
  const access = await jobAccess(pool, { userId: req.user.id, job });
  if (!access.can_view) throw new NotFound('Job not found');
  if (!access.can_view_history) {
    throw jobs.denyDecision(req.ctx, req.user, await decide(pool, { userId: req.user.id, action: 'job.view_history', job }), job, 'view approvals');
  }
  const { rows } = await pool.query(
    `SELECT ar.*, ru.name AS requested_by_name, du.name AS decided_by_name, (ar.expires_at > now()) AS live
       FROM approval_requests ar JOIN users ru ON ru.id = ar.requested_by LEFT JOIN users du ON du.id = ar.decided_by
      WHERE ar.job_id = $1 ORDER BY ar.id DESC`, [job.id]);
  res.json({ items: rows });
}));

// "Who could have changed this job on the 3rd?"  (point in time, uses time-versioned grants)
r.get('/jobs/:id/who-could-act', wrap(async (req, res) => {
  await requirePermission(pool, req.user, 'audit.read', req.ctx, 'who-could-act');
  const q = parse(schemas.whoCouldActQuery, req.query);
  res.json(await whoCouldAct(pool, { jobId: jobId(req), at: q.at, actions: q.action ? [q.action] : null }));
}));

export default r;
