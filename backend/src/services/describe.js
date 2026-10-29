// Plain-language descriptions: "Person A has role B for client C, branch D, direction E, mode F."

export function describeScope(s, ref) {
  return [
    s.client_id ? `client ${ref.clients.get(s.client_id) ?? s.client_id}` : 'all clients',
    s.branch_id ? `branch ${ref.branches.get(s.branch_id) ?? s.branch_id}` : 'all branches',
    s.direction ? `direction ${s.direction}` : 'all directions',
    s.mode ? `mode ${s.mode.toUpperCase()}` : 'all modes',
  ].join(', ');
}

export function describeJobScope(j, ref) {
  return `client ${ref.clients.get(j.client_id) ?? j.client_id}, branch ${ref.branches.get(j.branch_id) ?? j.branch_id}, ` +
         `direction ${j.direction}, mode ${String(j.mode).toUpperCase()}`;
}

const fmt = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export function describeGrant(g, ref, now = new Date()) {
  const who = g.user_name ?? `user ${g.user_id}`;
  let text = `${who} has role ${g.role_name ?? g.role_code} for ${describeScope(g, ref)}`;
  const from = new Date(g.valid_from);
  const to = g.valid_to ? new Date(g.valid_to) : null;
  let state = 'active';
  if (from > now) { state = 'future'; text += ` (starts ${fmt(from)})`; }
  else if (to && to <= now) { state = 'ended'; text += ` (ended ${fmt(to)})`; }
  else if (to) text += ` (until ${fmt(to)})`;
  return { description: `${text}.`, state };
}
