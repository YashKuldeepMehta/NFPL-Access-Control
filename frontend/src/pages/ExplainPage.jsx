import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, fmt } from '../api.js';
import { useUser } from '../UserContext.jsx';
import ReasonChecks from '../components/ReasonChecks.jsx';

const ACTIONS = ['job.view', 'job.view_internal', 'job.view_history', 'job.update', 'job.prepare', 'job.check', 'job.file', 'job.cancel',
  'job.cancel_filed', 'job.reopen', 'job.reassign', 'job.admin_fix', 'job.approve_dangerous'];

function Box({ title, hint, children }) {
  return <section className="card"><h3>{title}</h3><p className="muted">{hint}</p>{children}</section>;
}

export default function ExplainPage() {
  const { users, user } = useUser();
  const [params] = useSearchParams();
  const [job, setJob] = useState(params.get('job') ?? '');
  const [action, setAction] = useState('job.check');
  const [who, setWho] = useState(user.id);
  const [a, setA] = useState(user.id);
  const [b, setB] = useState(users[1]?.id ?? user.id);
  const [at, setAt] = useState(() => new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 16));
  const [one, setOne] = useState(null);
  const [cmp, setCmp] = useState(null);
  const [past, setPast] = useState(null);
  const [err, setErr] = useState('');

  const go = (fn) => async () => { setErr(''); try { await fn(); } catch (e) { setErr(e.message); } };
  const userSelect = (v, set) => <select value={v} onChange={(e) => set(Number(e.target.value))}>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>;
  const actionSelect = <select value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map((x) => <option key={x}>{x}</option>)}</select>;

  return (
    <div>
      <h2>Explain</h2>
      <div className="filters">Job id: <input size="6" value={job} onChange={(e) => setJob(e.target.value)} placeholder="e.g. 1" /> Action: {actionSelect}</div>
      {err && <div className="banner error">{err}</div>}

      <Box title="1. May this person do this on this job, and why?" hint="Asking about someone else needs the access.view permission (Access Admin).">
        {userSelect(who, setWho)}{' '}
        <button onClick={go(async () => { setOne(await api(`/can?user=${who}&action=${action}&job=${job}`)); })}>Explain</button>
        <ReasonChecks decision={one} />
      </Box>

      <Box title="2. Why can she do this and he can't?" hint="Compares two people on the same action and job and shows the first check where they differ.">
        {userSelect(a, setA)} vs {userSelect(b, setB)}{' '}
        <button onClick={go(async () => { setCmp(await api(`/explain/compare?a=${a}&b=${b}&action=${action}&job=${job}`)); })}>Compare</button>
        {cmp && (
          <>
            <p className="sentence">{cmp.sentence}</p>
            {cmp.difference && <p className="note">They differ at <b>{cmp.difference.check.replace(/_/g, ' ')}</b>.</p>}
            <div className="two"><ReasonChecks decision={cmp.a} /><ReasonChecks decision={cmp.b} /></div>
          </>
        )}
      </Box>

      <Box title="3. Who could have changed this job at a past time?" hint="Reconstructed from time-versioned grants, absences and the job's own history. Needs audit.read.">
        <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />{' '}
        <button onClick={go(async () => { setPast(await api(`/jobs/${job}/who-could-act?at=${encodeURIComponent(new Date(at).toISOString())}&action=${action}`)); })}>Who could act?</button>
        {past && (
          <div>
            <p><b>{past.job_no}</b> at {fmt(past.at)} — {past.scope}. Stage then: <b>{past.state?.stage ?? 'unknown'}</b></p>
            {past.note && <p className="muted">{past.note}</p>}
            {past.who.length > 0 && (
              <table><thead><tr><th>Person</th><th>Could do</th><th>Through</th></tr></thead><tbody>
                {past.who.map((w) => <tr key={w.user_id}><td>{w.name}</td><td>{w.actions.map((x) => x.action).join(', ')}</td><td>{w.actions.map((x) => `${x.role} #${x.grant_id} (${x.via})`).join('; ')}</td></tr>)}
              </tbody></table>
            )}
          </div>
        )}
      </Box>
    </div>
  );
}
