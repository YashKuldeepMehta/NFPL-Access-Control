import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api.js';
import JobTable from '../components/JobTable.jsx';

export default function WorklistPage() {
  const [data, setData] = useState({ items: [] });
  const [count, setCount] = useState(null);
  const [assigned, setAssigned] = useState('any');
  const [unattended, setUnattended] = useState(null);   // null = not allowed to see
  const [approvals, setApprovals] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      const [w, c, a] = await Promise.all([
        api(`/me/worklist?limit=100&assigned=${assigned}`),
        api(`/me/worklist/count?assigned=${assigned}`),
        api('/me/approvals'),
      ]);
      setData(w); setCount(c.count); setApprovals(a.items);
      try { setUnattended((await api('/me/unattended?limit=50')).items); } catch (e) {
        if (e instanceof ApiError && e.status === 403) setUnattended(null); else throw e;
      }
    } catch (e) { setError(e.message); }
  }, [assigned]);
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <h2>Jobs waiting for me <span className="badge">{count ?? '…'}</span></h2>
      <p className="muted">
        The count and this list come from the same query that answers "may I do this?", so they always agree.
        A job appears only if I could actually perform its next step right now.
      </p>
      {error && <div className="banner error">{error}</div>}
      <label>Show{' '}
        <select value={assigned} onChange={(e) => setAssigned(e.target.value)}>
          <option value="any">everything I can do</option>
          <option value="me">assigned to me</option>
          <option value="unassigned">unassigned</option>
        </select>
      </label>
      <JobTable items={data.items} extra={{
        title: 'Next step',
        render: (j) => <>{j.next_action.replace('job.', '')}{j.via_delegation && <span className="tag">covering</span>}{j.mine && <span className="tag mine">mine</span>}</>,
      }} />
      {data.next_cursor && <p className="muted">Showing the first 100. (The API pages with a cursor.)</p>}

      {approvals.length > 0 && (
        <>
          <h3>Approvals waiting for my decision</h3>
          <table>
            <thead><tr><th>Job</th><th>Action</th><th>Requested by</th><th>Reason</th></tr></thead>
            <tbody>
              {approvals.map((a) => (
                <tr key={a.id}>
                  <td><Link to={`/jobs/${a.job_id}`}>{a.job_no}</Link></td><td>{a.action}</td><td>{a.requested_by_name}</td><td>{a.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {unattended && (
        <>
          <h3>Unattended jobs <span className="badge warn">{unattended.length}</span></h3>
          <p className="muted">Assigned to someone who can no longer do the next step (absent with nobody covering, left, or their grant ended).</p>
          <JobTable items={unattended.map((j) => ({ ...j, client_name: j.client_id, branch_name: j.branch_id }))}
            extra={{ title: 'Why', render: (j) => `${j.owner_name}: ${j.unattended_reason}` }} />
        </>
      )}
    </div>
  );
}
