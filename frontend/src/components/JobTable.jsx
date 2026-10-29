import React from 'react';
import { Link } from 'react-router-dom';

export default function JobTable({ items, extra }) {
  if (!items.length) return <p className="muted">Nothing here.</p>;
  return (
    <table>
      <thead>
        <tr><th>Job</th><th>Client</th><th>Branch</th><th>Dir</th><th>Mode</th><th>Stage</th>{extra && <th>{extra.title}</th>}</tr>
      </thead>
      <tbody>
        {items.map((j) => (
          <tr key={j.id}>
            <td><Link to={`/jobs/${j.id}`}>{j.job_no}</Link></td>
            <td>{j.client_name}</td><td>{j.branch_name}</td><td>{j.direction}</td><td>{String(j.mode).toUpperCase()}</td>
            <td><span className={`stage ${j.stage}`}>{j.stage}</span></td>
            {extra && <td>{extra.render(j)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
