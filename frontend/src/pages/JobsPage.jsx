import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useUser } from '../UserContext.jsx';
import JobTable from '../components/JobTable.jsx';

const STAGES = ['confirmed', 'prepared', 'checked', 'filed', 'cancelled', 'reopened'];

export default function JobsPage() {
  const { ref } = useUser();
  const [stage, setStage] = useState('');
  const [client, setClient] = useState('');
  const [branch, setBranch] = useState('');
  const [data, setData] = useState({ items: [] });
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState('');

  const query = (cur) => `/jobs?limit=50&cursor=${cur}` + (stage ? `&stage=${stage}` : '') + (client ? `&client_id=${client}` : '') + (branch ? `&branch_id=${branch}` : '');
  useEffect(() => {
    setCursor(0);
    api(query(0)).then(setData).catch((e) => setError(e.message));
  }, [stage, client, branch]); // eslint-disable-line

  const more = async () => {
    const next = await api(query(data.next_cursor));
    setData({ items: [...data.items, ...next.items], next_cursor: next.next_cursor });
  };

  return (
    <div>
      <h2>Jobs I can see</h2>
      <p className="muted">Visibility is its own permission: you only see jobs inside the scope of your grants. A client user sees only their own client.</p>
      {error && <div className="banner error">{error}</div>}
      <div className="filters">
        <select value={stage} onChange={(e) => setStage(e.target.value)}><option value="">any stage</option>{STAGES.map((s) => <option key={s}>{s}</option>)}</select>
        <select value={client} onChange={(e) => setClient(e.target.value)}><option value="">any client</option>{ref.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">any branch</option>{ref.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      </div>
      <JobTable items={data.items} />
      {data.next_cursor && <button onClick={more}>Load more</button>}
    </div>
  );
}
