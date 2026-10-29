import { Router } from 'express';
import { pool } from '../db.js';
import { wrap } from '../middleware.js';
import { parse, schemas } from '../validation.js';
import { worklistPage, worklistCount, unattendedPage, pendingApprovals } from '../engine/worklist.js';
import { userAccess } from '../services/users.js';
import { requirePermission } from '../services/authority.js';

const r = Router();

r.get('/me', wrap(async (req, res) => {
  const a = await userAccess(req.user.id);
  res.json({ user: a.user, access: a.grants.filter((g) => g.state !== 'ended').map((g) => g.description), absences: a.absences });
}));

r.get('/me/worklist', wrap(async (req, res) => {
  const q = parse(schemas.worklistQuery, req.query);
  res.json(await worklistPage(pool, req.user.id, q));
}));

r.get('/me/worklist/count', wrap(async (req, res) => {
  const q = parse(schemas.worklistQuery.pick({ assigned: true }), req.query);
  res.json({ count: await worklistCount(pool, req.user.id, q) });
}));

// Jobs whose assigned owner can no longer do the next step. Only for people who may reassign.
r.get('/me/unattended', wrap(async (req, res) => {
  await requirePermission(pool, req.user, 'job.reassign', req.ctx);
  const q = parse(schemas.pagination, req.query);
  res.json(await unattendedPage(pool, req.user.id, q));
}));

// Approval requests this person could decide.
r.get('/me/approvals', wrap(async (req, res) => {
  res.json({ items: await pendingApprovals(pool, req.user.id) });
}));

export default r;
