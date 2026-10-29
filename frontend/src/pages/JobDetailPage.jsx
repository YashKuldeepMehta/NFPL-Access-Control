import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { useUser } from '../UserContext.jsx';

export default function JobDetailPage() {
  const { id } = useParams();
  const { user, users } = useUser();
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [reason, setReason] = useState('');
  const [fixStage, setFixStage] = useState('prepared');
  const [assignee, setAssignee] = useState('');
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api(`/jobs/${id}`);
      setData(d);
      if (d.access.can_view_history) {
        setHistory((await api(`/jobs/${id}/history`)).events);
        setApprovals((await api(`/jobs/${id}/approvals`)).items);
      } else { setHistory(null); setApprovals([]); }
    } catch (e) { setData({ error: e.message }); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const run = async (label, fn) => {
    try { await fn(); setMsg({ ok: true, text: `${label}: done` }); setReason(''); }
    catch (e) { setMsg({ ok: false, text: `${label}: ${e.message}`, decision: e.body?.error?.decision }); }
    load();
  };

  if (!data) return <p>Loading...</p>;
  if (data.error) return <div className="banner error">{data.error} (you may not have access to this job)</div>;
  const { job, access } = data;
  const act = (a) => a.action === 'job.reassign' || a.action === 'job.admin_fix' || a.action === 'job.update' || a.action === 'job.approve_dangerous';
  const stageActions = access.actions.filter((a) => !act(a));
  const can = (name) => access.actions.find((a) => a.action === name && a.allowed);

  return (
    <div>
      <p><Link to="/jobs">← Jobs</Link></p>
      <h2>{job.job_no} <span className={`stage ${job.stage}`}>{job.stage}</span></h2>
      {job.redacted && <div className="banner info">Internal fields are hidden for your role.</div>}
      <table className="kv"><tbody>
        <tr><th>Client</th><td>{job.client_name ?? job.client_id}</td><th>Branch</th><td>{job.branch_name ?? job.branch_id}</td></tr>
        <tr><th>Direction</th><td>{job.direction}</td><th>Mode</th><td>{String(job.mode).toUpperCase()}</td></tr>
        {!job.redacted && <>
          <tr><th>Prepared by</th><td>{name(users, job.prepared_by)}</td><th>Checked by</th><td>{name(users, job.checked_by)}</td></tr>
          <tr><th>Filed by</th><td>{name(users, job.filed_by)}</td><th>Assigned to</th><td>{name(users, job.owner_id)}</td></tr>
          <tr><th>Notes</th><td colSpan="3">{job.internal_notes}</td></tr>
        </>}
      </tbody></table>

      <h3>What I can do on this job</h3>
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}
      {stageActions.length === 0 && <p className="muted">Nothing: this role can only look at this job.</p>}
      {stageActions.length > 0 && (
        <div className="actions">
          <input placeholder="Reason (needed for cancel / reopen)" value={reason} onChange={(e) => setReason(e.target.value)} />
          {stageActions.map((a) => {
            const name_ = a.action.replace('job.', '');
            if (!a.allowed) return <button key={a.action} disabled title={`blocked by ${a.blocked_by}`}>{name_} (blocked: {a.blocked_by})</button>;
            if (a.requires_approval) {
              return <button key={a.action} onClick={() => run(`Request ${name_}`, () => api(`/jobs/${id}/approvals`, { method: 'POST', body: { action: a.action, reason } }))}>
                Request approval to {name_}</button>;
            }
            return <button key={a.action} onClick={() => run(name_, () => api(`/jobs/${id}/actions/${a.action}`, { method: 'POST', body: reason ? { reason } : {} }))}>
              {name_}{a.via_delegation ? ' (as delegate)' : ''}</button>;
          })}
        </div>
      )}

      {can('job.reassign') && (
        <div className="actions">
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">(nobody)</option>
            {users.filter((u) => u.type === 'staff').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button onClick={() => run('Assign', () => api(`/jobs/${id}/reassign`, { method: 'POST', body: { owner_id: assignee ? Number(assignee) : null } }))}>Assign</button>
          <span className="muted">The assignee must be able to do the next step.</span>
        </div>
      )}
      {can('job.admin_fix') && (
        <div className="actions">
          <b>Admin override</b>
          <select value={fixStage} onChange={(e) => setFixStage(e.target.value)}><option>confirmed</option><option>prepared</option><option>checked</option></select>
          <button onClick={() => run('Admin fix', () => api(`/jobs/${id}/admin-fix`, { method: 'POST', body: { to_stage: fixStage, reason } }))}>Send job back</button>
          <span className="muted">Needs a reason; can only go backwards; audited.</span>
        </div>
      )}

      {approvals.length > 0 && (
        <>
          <h3>Approval requests</h3>
          <table>
            <thead><tr><th>Action</th><th>By</th><th>Reason</th><th>Status</th><th /></tr></thead>
            <tbody>
              {approvals.map((a) => (
                <tr key={a.id}>
                  <td>{a.action}</td><td>{a.requested_by_name}</td><td>{a.reason}</td>
                  <td>{a.status}{a.status === 'pending' && !a.live && ' (expired)'}</td>
                  <td>
                    {a.status === 'pending' && a.live && a.requested_by !== user.id && <>
                      <button onClick={() => run('Approve', () => api(`/approvals/${a.id}/decide`, { method: 'POST', body: { decision: 'approve' } }))}>Approve</button>{' '}
                      <button onClick={() => run('Reject', () => api(`/approvals/${a.id}/decide`, { method: 'POST', body: { decision: 'reject' } }))}>Reject</button></>}
                    {a.status === 'approved' && a.live && a.requested_by === user.id &&
                      <button onClick={() => run('Execute', () => api(`/jobs/${id}/actions/${a.action}`, { method: 'POST', body: { approval_id: a.id } }))}>Execute</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h3>History</h3>
      {history === null && <p className="muted">Your role cannot see this job's history.</p>}
      {history && (
        <ul className="timeline">
          {history.map((e) => (
            <li key={e.id} className={e.outcome}><span className="time">{fmt(e.at)}</span> {e.summary}</li>
          ))}
        </ul>
      )}
      <p><Link to={`/explain?job=${id}`}>Explain who may do what on this job →</Link></p>
    </div>
  );
}
function name(users, id) { return id ? (users.find((u) => u.id === id)?.name ?? `user ${id}`) : '—'; }
