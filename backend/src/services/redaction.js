// Fields a client-side user (or anyone without job.view_internal) must never see.
const INTERNAL_FIELDS = ['internal_notes', 'customs_ref', 'owner_id', 'prepared_by', 'checked_by', 'filed_by', 'created_by'];

export function redactJob(job, canViewInternal) {
  const out = { ...job };
  delete out.can_view_internal;
  if (canViewInternal) return out;
  for (const f of INTERNAL_FIELDS) delete out[f];
  out.redacted = true;
  return out;
}
