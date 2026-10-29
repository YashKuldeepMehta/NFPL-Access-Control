// =====================================================================
// can(user, action, job) with an explanation, built on the ONE shared SQL (sql.js).
// Principle: default DENY. Anything unclear or any internal error => denied (fail closed).
// =====================================================================
import { EVALUATE_SQL, DIAGNOSE_GRANT_SQL } from './sql.js';
import { getRef } from '../services/ref.js';
import { describeScope, describeJobScope } from '../services/describe.js';

const CHECKS = ['user_active', 'grant_found', 'scope_match', 'stage_allows', 'separation_of_duties'];

/** The part of a job the engine needs. Works for a live job row and for a reconstructed past state. */
export function snapshotOf(job) {
  return {
    id: job.id ?? null,
    job_no: job.job_no ?? null,
    client_id: job.client_id,
    branch_id: job.branch_id,
    direction: job.direction,
    mode: job.mode,
    stage: job.stage ?? null,
    prepared_by: job.prepared_by ?? null,
    checked_by: job.checked_by ?? null,
  };
}

/** Raw evaluation: one query. `action = null` returns every effective permission. */
export async function evaluate(db, { userId, at = null, action = null, job }) {
  const j = snapshotOf(job);
  const { rows } = await db.query(EVALUATE_SQL, [
    userId, at, action, j.client_id, j.branch_id, j.direction, j.mode, j.stage, j.prepared_by, j.checked_by,
  ]);
  const m = rows[0];
  const meta = {
    user_found: m.user_found === 1,
    user_active: m.user_active === true,
    user_name: m.user_name,
    absent_now: m.absent_now,
    absence_delegate_id: m.absence_delegate_id,
    perm_exists: m.perm_exists,
    evaluated_at: m.evaluated_at,
  };
  return { meta, cands: rows.filter((r) => r.grant_id != null) };
}

const label = (j) => (j.job_no ? `job ${j.job_no}` : j.id ? `job #${j.id}` : 'a new job');

function failClosed(base, code, summary, extra = {}) {
  return {
    allowed: false, action: base.action, user_id: base.userId, job_id: base.job?.id ?? null,
    reason_code: code, summary, checks: CHECKS.map((name) => ({ name, pass: null, detail: 'not evaluated' })),
    grant: null, requires: { reason: false, approval: false }, to_stage: null, ...extra,
  };
}

/** Decide one action on one job. Never throws: failures become a denial with reason FAIL_CLOSED. */
export async function decide(db, { userId, action, job, at = null }) {
  const base = { action, userId, job };
  try {
    if (!userId || !action || !job) return failClosed(base, 'MISSING_INPUT', 'Missing user, action or job; denying.');
    if (job.stage == null && action !== 'job.create') {
      return failClosed(base, 'MISSING_INPUT', 'The job has no stage; denying.');
    }
    const { meta, cands } = await evaluate(db, { userId, at, action, job });
    return await buildDecision(db, base, meta, cands, at);
  } catch (err) {
    console.error('[decide] failing closed:', err.message);
    return failClosed(base, 'FAIL_CLOSED', `Could not decide safely (${err.message}); denying.`);
  }
}

async function buildDecision(db, base, meta, cands, at) {
  const { action, userId, job } = base;
  const ref = await getRef();
  const checks = [];
  const who = meta.user_name ?? `user ${userId}`;
  const jobScope = describeJobScope(job, ref);

  const finish = (allowed, code, summary, extra = {}) => {
    for (const name of CHECKS) {
      if (!checks.find((c) => c.name === name)) checks.push({ name, pass: null, detail: 'not evaluated (an earlier check failed)' });
    }
    checks.sort((a, b) => CHECKS.indexOf(a.name) - CHECKS.indexOf(b.name));
    return {
      allowed, action, user_id: userId, user_name: meta.user_name, job_id: job.id ?? null, job_no: job.job_no ?? null,
      evaluated_at: meta.evaluated_at, reason_code: code, summary, checks,
      grant: null, requires: { reason: false, approval: false }, to_stage: null, ...extra,
    };
  };

  if (!meta.perm_exists) {
    checks.push({ name: 'user_active', pass: null, detail: 'not evaluated' });
    return finish(false, 'UNKNOWN_ACTION', `'${action}' is not a known permission; denying.`);
  }
  if (!meta.user_found) return finish(false, 'USER_NOT_FOUND', `User ${userId} does not exist.`);

  // 1. user active
  checks.push({ name: 'user_active', pass: meta.user_active, detail: meta.user_active ? `${who} is active` : `${who} is disabled` });
  if (!meta.user_active) return finish(false, 'USER_DISABLED', `${who} is disabled, so everything is denied.`);

  // 2. any usable grant that gives this permission?
  if (cands.length === 0) {
    const why = await diagnoseNoGrant(db, userId, action, meta, at);
    checks.push({ name: 'grant_found', pass: false, detail: why.detail });
    return finish(false, why.code, `${who} cannot ${action}: ${why.detail}`);
  }
  checks.push({
    name: 'grant_found', pass: true,
    detail: `${who} holds ${cands.length} usable grant(s) with ${action}: ` +
      [...new Set(cands.map((c) => `${c.role_name} #${c.grant_id}${c.absence_id ? ` (covering ${c.via_name})` : ''}`))].join(', '),
  });

  // 3. scope
  const inScope = cands.filter((c) => c.scope_ok);
  if (!inScope.length) {
    const have = [...new Set(cands.map((c) =>
      `${c.role_name} #${c.grant_id}: ${describeScope({ client_id: c.g_client_id, branch_id: c.g_branch_id, direction: c.g_direction, mode: c.g_mode }, ref)}`))].join(' | ');
    checks.push({ name: 'scope_match', pass: false, detail: `grants cover [${have}] but the job is in ${jobScope}` });
    return finish(false, 'OUT_OF_SCOPE', `${who}'s ${action} access does not cover ${label(job)} (${jobScope}).`);
  }
  checks.push({ name: 'scope_match', pass: true, detail: `job is in ${jobScope}, covered by grant(s) ${inScope.map((c) => '#' + c.grant_id).join(', ')}` });

  // 4. stage
  const stageOk = inScope.filter((c) => c.stage_ok);
  if (!stageOk.length) {
    checks.push({ name: 'stage_allows', pass: false, detail: `${action} is not allowed while a job is '${job.stage}'` });
    return finish(false, 'STAGE_NOT_ALLOWED', `${action} is not allowed on ${label(job)} while it is '${job.stage}'.`);
  }
  checks.push({ name: 'stage_allows', pass: true, detail: job.stage ? `${action} is allowed in stage '${job.stage}'` : 'creating a new job' });

  // 5. separation of duties
  const sodOk = stageOk.filter((c) => c.sod_ok);
  if (!sodOk.length) {
    const ids = [job.prepared_by, job.checked_by].filter(Boolean);
    const names = new Map();
    if (ids.length) {
      const r = await db.query('SELECT id, name FROM users WHERE id = ANY($1::int[])', [ids]);
      r.rows.forEach((u) => names.set(u.id, u.name));
    }
    const sod = await db.query('SELECT actor_column FROM sod_rules WHERE action = $1', [action]);
    const parts = sod.rows.map((s) => {
      const pid = job[s.actor_column];
      return `${s.actor_column === 'prepared_by' ? 'prepared' : 'checked'} by ${names.get(pid) ?? pid}`;
    });
    const viaNames = [...new Set(stageOk.filter((c) => c.absence_id).map((c) => c.via_name))];
    const detail = `${label(job)} was ${parts.join(' and ')}; the same person (${who}${viaNames.length ? `, or ${viaNames.join('/')} whom they cover` : ''}) cannot also ${action.replace('job.', '')} it`;
    checks.push({ name: 'separation_of_duties', pass: false, detail });
    return finish(false, 'SOD_VIOLATION', `${who} cannot ${action} ${label(job)}: ${detail}.`);
  }
  checks.push({ name: 'separation_of_duties', pass: true, detail: 'no separation-of-duties conflict' });

  // Allowed. Prefer a direct grant over a delegated one (rows are already ordered that way).
  const w = sodOk[0];
  const delegated = w.absence_id != null;
  const requires = { reason: !!w.requires_reason, approval: !!w.requires_approval };
  return finish(true, delegated ? 'ALLOWED_VIA_DELEGATION' : 'ALLOWED_BY_GRANT',
    `${who} may ${action} ${label(job)}: ${delegated ? `covering ${w.via_name}, ` : ''}${w.role_name} grant #${w.grant_id} covers ${jobScope}.` +
    (requires.approval ? ' A second person must approve first.' : requires.reason ? ' A reason is required.' : ''),
    {
      grant: { grant_id: w.grant_id, role: w.role_name, role_code: w.role_code, via_user: w.via_user, via_name: w.via_name, delegated },
      requires, to_stage: w.to_stage ?? null,
    });
}

async function diagnoseNoGrant(db, userId, action, meta, at) {
  if (meta.absent_now) {
    return {
      code: 'USER_ABSENT',
      detail: meta.absence_delegate_id
        ? 'the user is absent; their own access is suspended while their delegate covers for them'
        : 'the user is absent and nobody is covering for them',
    };
  }
  const { rows } = await db.query(DIAGNOSE_GRANT_SQL, [userId, action]);
  if (rows.length) {
    const g = rows[0];
    const when = g.valid_to && new Date(g.valid_to) <= new Date(at ?? Date.now())
      ? `ended ${new Date(g.valid_to).toISOString().slice(0, 10)}`
      : `is not active at this time (valid from ${new Date(g.valid_from).toISOString().slice(0, 10)})`;
    return { code: 'GRANT_NOT_ACTIVE', detail: `the ${g.role_name} grant #${g.grant_id} that gives ${action} ${when}` };
  }
  return { code: 'NO_PERMISSION', detail: `none of the user's roles contains ${action}` };
}

/**
 * Everything one person may do (or see) on one job, from a SINGLE evaluation.
 * Used by GET /jobs/:id and the UI's action buttons.
 */
export async function jobAccess(db, { userId, job, at = null }) {
  const { meta, cands } = await evaluate(db, { userId, at, action: null, job });
  const ok = (c) => c.scope_ok && c.stage_ok && c.sod_ok;
  const has = (p) => cands.some((c) => c.permission_code === p && ok(c));
  const byAction = new Map();
  for (const c of cands.filter((x) => x.scope_ok)) {
    const cur = byAction.get(c.permission_code) ?? { action: c.permission_code, allowed: false, blocked_by: null,
      requires_reason: false, requires_approval: false, to_stage: null, via_delegation: false };
    if (ok(c)) {
      cur.allowed = true; cur.blocked_by = null;
      cur.requires_reason = !!c.requires_reason; cur.requires_approval = !!c.requires_approval;
      cur.to_stage = c.to_stage; cur.via_delegation = c.absence_id != null;
    } else if (!cur.allowed) {
      cur.blocked_by = !c.stage_ok ? 'stage' : 'separation_of_duties';
    }
    byAction.set(c.permission_code, cur);
  }
  return {
    active: meta.user_active,
    can_view: has('job.view'),
    can_view_internal: has('job.view_internal'),
    can_view_history: has('job.view_history'),
    actions: [...byAction.values()].filter((a) => !a.action.startsWith('job.view')),
  };
}
