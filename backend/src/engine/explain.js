// "Why can she do this and he can't?"  and  "Who could have changed this job on the 3rd?"
// Both reuse the SAME decision engine, so there is no second implementation that could drift.
import { decide, evaluate, snapshotOf } from './decision.js';
import { getRef } from '../services/ref.js';
import { describeJobScope } from '../services/describe.js';
import { NotFound } from '../errors.js';

// ---------------------------------------------------------------------
// Compare two people on the same action and job
// ---------------------------------------------------------------------
export async function compare(db, { a, b, action, job }) {
  const [da, dbb] = await Promise.all([
    decide(db, { userId: a, action, job }),
    decide(db, { userId: b, action, job }),
  ]);
  let difference = null;
  for (let i = 0; i < da.checks.length; i++) {
    const ca = da.checks[i];
    const cb = dbb.checks[i];
    if (ca.pass !== cb.pass) {
      difference = {
        check: ca.name,
        a: { pass: ca.pass, detail: ca.detail },
        b: { pass: cb.pass, detail: cb.detail },
      };
      break;
    }
  }
  const nameA = da.user_name ?? `user ${a}`;
  const nameB = dbb.user_name ?? `user ${b}`;
  let sentence;
  if (da.allowed === dbb.allowed) {
    sentence = da.allowed
      ? `Both ${nameA} and ${nameB} may ${action} this job.`
      : `Neither ${nameA} nor ${nameB} may ${action} this job. ${nameA}: ${da.reason_code}. ${nameB}: ${dbb.reason_code}.`;
  } else {
    const [yes, no, dy, dn] = da.allowed ? [nameA, nameB, da, dbb] : [nameB, nameA, dbb, da];
    sentence = `${yes} may ${action} this job but ${no} may not. ${dy.summary} Whereas: ${dn.summary}`;
  }
  return { action, a: da, b: dbb, difference, same_outcome: da.allowed === dbb.allowed, sentence };
}

// ---------------------------------------------------------------------
// Reconstruct a job's state at a past time from the audit trail.
// Every job.created / job.transition / job.admin_fix event stores the full "after" state.
// Job scope (client/branch/direction/mode) is immutable (DB trigger), so it can be read from the job row.
// ---------------------------------------------------------------------
export async function snapshotAt(db, jobId, at) {
  const { rows } = await db.query(
    `SELECT at, event, detail->'after' AS after
       FROM audit_log
      WHERE job_id = $1 AND event IN ('job.created','job.transition','job.admin_fix') AND at <= $2::timestamptz
      ORDER BY at DESC, id DESC LIMIT 1`, [jobId, at]);
  return rows[0] ? { as_of_event: rows[0].event, event_at: rows[0].at, ...rows[0].after } : null;
}

const MUTATING = ['job.update', 'job.prepare', 'job.check', 'job.file', 'job.cancel', 'job.cancel_filed',
  'job.reopen', 'job.reassign', 'job.admin_fix'];

export async function whoCouldAct(db, { jobId, at, actions }) {
  const jobRes = await db.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
  const job = jobRes.rows[0];
  if (!job) throw new NotFound('Job not found');
  const atDate = new Date(at);
  const ref = await getRef();
  const base = { job_id: job.id, job_no: job.job_no, at: atDate.toISOString(), scope: describeJobScope(job, ref) };

  if (new Date(job.created_at) > atDate) {
    return { ...base, job_existed: false, stage_known: false, state: null, who: [],
      note: 'The job did not exist yet at that time, so nobody could have changed it.' };
  }
  const snap = await snapshotAt(db, jobId, atDate);
  if (!snap) {
    return { ...base, job_existed: true, stage_known: false, state: null, who: [],
      note: 'No history is recorded for this job at that time, so the stage is unknown. Failing closed: reporting nobody.' };
  }
  const state = { stage: snap.stage, prepared_by: snap.prepared_by ?? null, checked_by: snap.checked_by ?? null,
    filed_by: snap.filed_by ?? null, owner_id: snap.owner_id ?? null };
  const wanted = new Set(actions?.length ? actions : MUTATING);
  const target = snapshotOf({ ...job, ...state });

  // Candidates: everyone who held a grant, or covered for someone, at that moment.
  const cand = await db.query(
    `SELECT u.id, u.name FROM users u
      WHERE u.id IN (SELECT user_id FROM grants WHERE $1::timestamptz >= valid_from AND (valid_to IS NULL OR $1::timestamptz < valid_to))
         OR u.id IN (SELECT delegate_id FROM absences WHERE delegate_id IS NOT NULL AND $1::timestamptz >= valid_from AND $1::timestamptz < valid_to)
      ORDER BY u.name`, [atDate]);

  const who = [];
  for (let i = 0; i < cand.rows.length; i += 8) {
    const chunk = cand.rows.slice(i, i + 8);
    const results = await Promise.all(chunk.map((u) => evaluate(db, { userId: u.id, at: atDate, action: null, job: target })));
    results.forEach((r, k) => {
      const perUser = new Map();
      for (const c of r.cands) {
        if (!wanted.has(c.permission_code) || !(c.scope_ok && c.stage_ok && c.sod_ok)) continue;
        if (!perUser.has(c.permission_code)) {
          perUser.set(c.permission_code, {
            action: c.permission_code, role: c.role_name, grant_id: c.grant_id,
            via: c.absence_id ? `delegation (covering ${c.via_name})` : 'own grant',
            needs_second_approver: !!c.requires_approval,
          });
        }
      }
      if (perUser.size) who.push({ user_id: chunk[k].id, name: chunk[k].name, actions: [...perUser.values()] });
    });
  }
  return { ...base, job_existed: true, stage_known: true, state, who,
    note: who.length ? null : 'Nobody could have acted on this job at that time.' };
}
