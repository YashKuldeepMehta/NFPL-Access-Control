// Helpers shared by the seed scripts and the tests: create a job TOGETHER with a consistent audit history,
// so that "who could have changed this job on the 3rd?" has real data to reconstruct from.
export const STAGE_AFTER = {
  'job.prepare': 'prepared', 'job.check': 'checked', 'job.file': 'filed',
  'job.cancel': 'cancelled', 'job.cancel_filed': 'cancelled', 'job.reopen': 'reopened',
};

/**
 * spec: { client_id, branch_id, direction, mode, created_by, created_at, internal_notes?, customs_ref?,
 *         steps: [{ action, actor, at, reason?, approval?: { requested_by, decided_by, requested_at, decided_at, reason } }],
 *         owner_id?, owner_set_at?, assigned_by? }
 * All user fields are user IDS and all times are Dates.
 */
export async function createJobWithHistory(db, spec) {
  let st = { stage: 'confirmed', prepared_by: null, checked_by: null, filed_by: null, owner_id: null };
  const events = [{ at: spec.created_at, actor: spec.created_by, event: 'job.created', detail: { after: { ...st } } }];
  const approvals = [];
  let last = spec.created_at;

  for (const s of spec.steps ?? []) {
    const from = st.stage;
    st = { ...st, stage: STAGE_AFTER[s.action], owner_id: null };
    if (s.action === 'job.prepare') st.prepared_by = s.actor;
    if (s.action === 'job.check') st.checked_by = s.actor;
    if (s.action === 'job.file') st.filed_by = s.actor;
    if (s.action === 'job.reopen') { st.checked_by = null; st.filed_by = null; }
    const detail = { action: s.action, from_stage: from, to_stage: st.stage, reason: s.reason ?? null, approval_id: null, after: { ...st } };
    if (s.approval) approvals.push({ ...s.approval, action: s.action, detail });
    events.push({ at: s.at, actor: s.actor, event: 'job.transition', detail });
    last = s.at;
  }
  if (spec.owner_id) {
    const at = spec.owner_set_at ?? last;
    events.push({ at, actor: spec.assigned_by ?? spec.created_by, event: 'job.reassigned', detail: { from_owner_id: null, owner_id: spec.owner_id } });
    st.owner_id = spec.owner_id;
    if (at > last) last = at;
  }

  const { rows } = await db.query(
    `INSERT INTO jobs (job_no, client_id, branch_id, direction, mode, stage, owner_id, prepared_by, checked_by, filed_by,
                       internal_notes, customs_ref, created_by, created_at, updated_at)
     VALUES ('NF-' || lpad(nextval('job_no_seq')::text, 6, '0'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    [spec.client_id, spec.branch_id, spec.direction, spec.mode, st.stage, st.owner_id, st.prepared_by, st.checked_by, st.filed_by,
     spec.internal_notes ?? null, spec.customs_ref ?? null, spec.created_by, spec.created_at, last]);
  const jobId = rows[0].id;

  for (const a of approvals) {
    const ap = await db.query(
      `INSERT INTO approval_requests (job_id, action, requested_by, reason, status, decided_by, decided_at, created_at, expires_at)
       VALUES ($1,$2,$3,$4,'executed',$5,$6,$7,$7::timestamptz + interval '24 hours') RETURNING id`,
      [jobId, a.action, a.requested_by, a.reason, a.decided_by, a.decided_at, a.requested_at]);
    a.detail.approval_id = ap.rows[0].id;
    events.push({ at: a.requested_at, actor: a.requested_by, event: 'approval.requested', detail: { action: a.action, reason: a.reason, approval_id: ap.rows[0].id } });
    events.push({ at: a.decided_at, actor: a.decided_by, event: 'approval.decided', detail: { action: a.action, decision: 'approve', approval_id: ap.rows[0].id } });
  }

  events.sort((x, y) => x.at - y.at);
  await db.query(
    `INSERT INTO audit_log (at, actor_id, event, entity_type, entity_id, job_id, outcome, detail)
     SELECT t.at, t.actor_id, t.event, 'job', $1::text, $1::int, 'allow', t.detail::jsonb
       FROM unnest($2::timestamptz[], $3::int[], $4::text[], $5::text[]) AS t(at, actor_id, event, detail)`,
    [jobId, events.map((e) => e.at), events.map((e) => e.actor), events.map((e) => e.event), events.map((e) => JSON.stringify(e.detail))]);
  return jobId;
}
