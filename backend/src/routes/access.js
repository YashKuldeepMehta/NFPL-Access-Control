import { Router } from 'express';
import { pool } from '../db.js';
import { wrap } from '../middleware.js';
import { parse, schemas } from '../validation.js';
import { createGrant, endGrant } from '../services/grants.js';
import { createAbsence, endAbsence } from '../services/absences.js';
import { createRole, setRolePermissions, listRoles } from '../services/roles.js';
import { listUsers, userAccess, disableUser } from '../services/users.js';
import { decideApproval } from '../services/approvals.js';
import { searchAudit } from '../services/audit.js';
import { requirePermission } from '../services/authority.js';
import { Forbidden } from '../errors.js';

const r = Router();
const idParam = (req, name = 'id') => parse(schemas.id, req.params[name]);

r.get('/users', wrap(async (req, res) => {
  await requirePermission(pool, req.user, 'access.view', req.ctx);
  res.json({ items: await listUsers() });
}));

// A person may read their own access; reading anyone else's needs access.view.
r.get('/users/:id/access', wrap(async (req, res) => {
  const id = idParam(req);
  if (id !== req.user.id) await requirePermission(pool, req.user, 'access.view', req.ctx);
  res.json(await userAccess(id));
}));

r.post('/users/:id/disable', wrap(async (req, res) => {
  res.json(await disableUser(req.user, idParam(req), parse(schemas.disableUser, req.body), req.ctx));
}));

r.post('/grants', wrap(async (req, res) => {
  res.status(201).json(await createGrant(req.user, parse(schemas.createGrant, req.body), req.ctx));
}));
r.post('/grants/:id/end', wrap(async (req, res) => {
  res.json(await endGrant(req.user, idParam(req), parse(schemas.endGrant, req.body), req.ctx));
}));

r.post('/absences', wrap(async (req, res) => {
  res.status(201).json(await createAbsence(req.user, parse(schemas.createAbsence, req.body), req.ctx));
}));
r.post('/absences/:id/end', wrap(async (req, res) => {
  res.json(await endAbsence(req.user, idParam(req), req.ctx));
}));

r.get('/roles', wrap(async (req, res) => {
  await requirePermission(pool, req.user, 'access.view', req.ctx);
  res.json({ items: await listRoles() });
}));
r.get('/permissions', wrap(async (req, res) => {
  await requirePermission(pool, req.user, 'access.view', req.ctx);
  res.json({ items: (await pool.query('SELECT code, description, is_dangerous FROM permissions ORDER BY code')).rows });
}));
r.post('/roles', wrap(async (req, res) => {
  res.status(201).json(await createRole(req.user, parse(schemas.createRole, req.body), req.ctx));
}));
r.put('/roles/:id/permissions', wrap(async (req, res) => {
  res.json(await setRolePermissions(req.user, idParam(req), parse(schemas.setRolePermissions, req.body), req.ctx));
}));

r.post('/approvals/:id/decide', wrap(async (req, res) => {
  res.json(await decideApproval(req.user, idParam(req), parse(schemas.approvalDecision, req.body), req.ctx));
}));

r.get('/audit', wrap(async (req, res) => {
  await requirePermission(pool, req.user, 'audit.read', req.ctx);
  res.json({ items: await searchAudit(parse(schemas.auditQuery, req.query)) });
}));

export default r;
