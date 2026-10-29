import React, { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';

export default function AuditPage() {
  const [event, setEvent] = useState('');
  const [job, setJob] = useState('');
  const [items, setItems] = useState([]);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      setErr('');
      setItems((await api(`/audit?limit=100${event ? `&event=${event}` : ''}${job ? `&job=${job}` : ''}`)).items);
    } catch (e) { setErr(e.message); setItems([]); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  return (
    <div>
      <h2>Audit log</h2>
      <p className="muted">Append-only (the database refuses updates and deletes). Denied attempts are recorded too. Needs audit.read.</p>
      <div className="filters">
        <select value={event} onChange={(e) => setEvent(e.target.value)}>
          <option value="">all events</option>
          {['access.denied', 'job.created', 'job.transition', 'job.admin_fix', 'approval.requested', 'approval.decided', 'grant.created', 'grant.ended', 'absence.created', 'role.created'].map((x) => <option key={x}>{x}</option>)}
        </select>
        <input size="6" placeholder="job id" value={job} onChange={(e) => setJob(e.target.value)} />
        <button onClick={load}>Search</button>
      </div>
      {err && <div className="banner error">{err}</div>}
      <ul className="timeline">
        {items.map((e) => <li key={e.id} className={e.outcome}><span className="time">{fmt(e.at)}</span> {e.summary}</li>)}
      </ul>
    </div>
  );
}
