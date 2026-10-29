// Tiny fetch wrapper. Identity is SIMULATED: the chosen user's id is sent as X-User-Id.
let currentUserId = null;
export const setApiUser = (id) => { currentUserId = id; };

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.body = body;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(currentUserId ? { 'X-User-Id': String(currentUserId) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const fmt = (d) => (d ? new Date(d).toLocaleString() : '');
