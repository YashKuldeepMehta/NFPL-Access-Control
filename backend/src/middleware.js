import crypto from 'node:crypto';
import { pool } from './db.js';
import { AppError, Forbidden } from './errors.js';
import { record } from './services/audit.js';

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function requestContext(req, res, next) {
  req.ctx = { requestId: crypto.randomUUID() };
  res.set('X-Request-Id', req.ctx.requestId);
  next();
}

/**
 * Identity is SIMULATED (assumption, see README): the caller names themselves with
 * X-User-Id or X-User-Email. Real SSO/JWT is out of scope; this is the single place to replace.
 */
export const authenticate = wrap(async (req, res, next) => {
  const id = req.get('X-User-Id');
  const email = req.get('X-User-Email');
  if (!id && !email) throw new AppError(401, 'UNAUTHENTICATED', 'Send an X-User-Id (or X-User-Email) header.');
  let rows;
  if (id) {
    if (!/^\d+$/.test(id)) throw new AppError(401, 'UNAUTHENTICATED', 'X-User-Id must be a number.');
    ({ rows } = await pool.query('SELECT * FROM users WHERE id = $1', [Number(id)]));
  } else {
    ({ rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]));
  }
  if (!rows[0]) throw new AppError(401, 'UNAUTHENTICATED', 'Unknown user.');
  if (rows[0].disabled_at) throw new AppError(403, 'USER_DISABLED', 'This account is disabled.');
  req.user = rows[0];
  next();
});

// eslint-disable-next-line no-unused-vars
export async function errorHandler(err, req, res, next) {
  if (err instanceof Forbidden && err.audit) {
    // Written outside the (rolled back) transaction so the denied attempt is never lost.
    try {
      await record(pool, { ...err.audit, event: 'access.denied', outcome: 'deny' });
    } catch (e) {
      console.error('[audit] could not record denial:', e.message);
    }
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON.' } });
  }
  console.error('[unhandled]', err);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected error (denied by default).' } });
}
