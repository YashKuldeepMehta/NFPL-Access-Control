import React, { useEffect, useState } from 'react';
import { api, fmt } from '../api.js';
import { useUser } from '../UserContext.jsx';

export default function AccessPage() {
  const { users, user, ref } = useUser();
  const [target, setTarget] = useState(user.id);
  const [info, setInfo] = useState(null);
  const [roles, setRoles] = useState([]);
  const [form, setForm] = useState({ role_code: 'maker', client_id: '', branch_id: '', direction: '', mode: '', reason: '' });
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try { setInfo(await api(`/users/${target}/access`)); } catch (e) { setInfo({ error: e.message }); }
  };
  useEffect(() => { load(); }, [target]); // eslint-disable-line
  useEffect(() => { api('/roles').then((r) => setRoles(r.items)).catch(() => setRoles([])); }, []);

  const run = async (label, fn) => {
    try { await fn(); setMsg({ ok: true, text: `${label}: done` }); }
    catch (e) { setMsg({ ok: false, text: `${label}: ${e.code ?? ''} ${e.message}` }); }
    load();
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const grant = () => run('Grant', () => api('/grants', { method: 'POST', body: {
    user_id: Number(target), role_code: form.role_code, reason: form.reason,
    client_id: form.client_id ? Number(form.client_id) : null, branch_id: form.branch_id ? Number(form.branch_id) : null,
    direction: form.direction || null, mode: form.mode || null } }));

  return (
    <div>
      <h2>Who has what</h2>
      <p className="muted">Everyone can read their own access. Reading or changing anyone else's needs the Access Admin role. Nothing is ever deleted: a grant is ended, so history stays true.</p>
      <label>Person{' '}
        <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
      </label>
      {msg && <div className={`banner ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}
      {info?.error && <div className="banner error">{info.error}</div>}
      {info?.grants && (
        <>
          <h3>Grants</h3>
          <ul className="grants">
            {info.grants.map((g) => (
              <li key={g.id} className={g.state}>
                {g.description} <span className="muted">(by {g.granted_by_name}, {g.reason})</span>
                {g.state !== 'ended' && <button onClick={() => run('End grant', () => api(`/grants/${g.id}/end`, { method: 'POST', body: { reason: 'Ended from the UI' } }))}>End</button>}
              </li>
            ))}
          </ul>
          {info.absences.length > 0 && (<><h3>Absences / delegations</h3><ul>
            {info.absences.map((a) => <li key={a.id}>{a.user_name} absent {fmt(a.valid_from)} to {fmt(a.valid_to)}; {a.delegate_name ? `${a.delegate_name} covers` : 'nobody covers'}.</li>)}
          </ul></>)}
          <h3>Grant a role to {info.user.name}</h3>
          <div className="filters">
            <select value={form.role_code} onChange={set('role_code')}>{(roles.length ? roles : [{ code: 'maker', name: 'Maker' }]).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</select>
            <select value={form.client_id} onChange={set('client_id')}><option value="">all clients</option>{ref.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <select value={form.branch_id} onChange={set('branch_id')}><option value="">all branches</option>{ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            <select value={form.direction} onChange={set('direction')}><option value="">both directions</option><option>import</option><option>export</option></select>
            <select value={form.mode} onChange={set('mode')}><option value="">all modes</option><option value="air">air</option><option value="fcl">fcl</option><option value="lcl">lcl</option></select>
            <input placeholder="Reason (required)" value={form.reason} onChange={set('reason')} />
            <button onClick={grant}>Grant</button>
          </div>
          <p className="muted">Try it as an admin: granting to yourself, granting Controller, or widening your own scope is refused (and logged).</p>
        </>
      )}
    </div>
  );
}
