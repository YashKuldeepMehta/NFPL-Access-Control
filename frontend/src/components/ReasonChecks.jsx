import React from 'react';

// Renders an explanation from the backend: a verdict plus the ordered checks with ticks and crosses.
export default function ReasonChecks({ decision }) {
  if (!decision) return null;
  return (
    <div className={`decision ${decision.allowed ? 'allowed' : 'denied'}`}>
      <div className="verdict">
        {decision.allowed ? 'ALLOWED' : 'DENIED'} <span className="code">{decision.reason_code}</span>
      </div>
      <p>{decision.summary}</p>
      <ul className="checks">
        {decision.checks.map((c) => (
          <li key={c.name} className={c.pass === true ? 'ok' : c.pass === false ? 'bad' : 'skip'}>
            <span className="mark">{c.pass === true ? '✔' : c.pass === false ? '✘' : '–'}</span>
            <b>{c.name.replace(/_/g, ' ')}</b>: {c.detail}
          </li>
        ))}
      </ul>
      {decision.allowed && (decision.requires?.approval || decision.requires?.reason) && (
        <p className="note">
          Needs: {decision.requires.reason && 'a reason'}{decision.requires.reason && decision.requires.approval && ' + '}
          {decision.requires.approval && "a second person's approval"}
        </p>
      )}
    </div>
  );
}
