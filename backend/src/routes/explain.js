import { Router } from 'express';
import { pool } from '../db.js';
import { wrap } from '../middleware.js';
import { parse, schemas } from '../validation.js';
import { decide, jobAccess } from '../engine/decision.js';
import { compare } from '../engine/explain.js';
import { loadJob } from '../services/jobs.js';
import { authorities } from '../services/authority.js';
import { NotFound, Forbidden } from '../errors.js';

const r = Router();

/** The caller may ask about a job if they can see it, or if they hold access.view (an auditor/admin). */
async function loadJobForExplain(caller, jobId) {
  const job = await loadJob(pool, jobId);
  const isViewer = (await authorities(pool, caller.id, 'access.view')).length > 0;
  if (!isViewer && !(await jobAccess(pool, { userId: caller.id, job })).can_view) throw new NotFound('Job not found');
  return { job, isViewer };
}

// "May this person perform this action on this job, and why?"  (dry run, changes nothing)
r.get('/can', wrap(async (req, res) => {
  const q = parse(schemas.canQuery, req.query);
  const target = q.user ?? req.user.id;
  const { job, isViewer } = await loadJobForExplain(req.user, q.job);
  if (target !== req.user.id && !isViewer) {
    throw new Forbidden('MISSING_PERMISSION', 'Asking about another person needs the access.view permission.');
  }
  res.json(await decide(pool, { userId: target, action: q.action, job }));
}));

// "Why can she do this and he can't?"
r.get('/explain/compare', wrap(async (req, res) => {
  const q = parse(schemas.compareQuery, req.query);
  const { job, isViewer } = await loadJobForExplain(req.user, q.job);
  if (!isViewer) throw new Forbidden('MISSING_PERMISSION', 'Comparing people needs the access.view permission.');
  res.json(await compare(pool, { a: q.a, b: q.b, action: q.action, job }));
}));

export default r;
