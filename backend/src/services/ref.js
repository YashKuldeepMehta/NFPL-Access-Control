// Names of branches and clients, for readable explanations. This is REFERENCE data used only
// for wording; it never influences an allow/deny decision, so a short cache is safe.
import { pool } from '../db.js';

let cache = null;
let loadedAt = 0;

export async function getRef() {
  if (cache && Date.now() - loadedAt < 60_000) return cache;
  const [c, b] = await Promise.all([
    pool.query('SELECT id, name FROM clients'),
    pool.query('SELECT id, name FROM branches'),
  ]);
  cache = {
    clients: new Map(c.rows.map((r) => [r.id, r.name])),
    branches: new Map(b.rows.map((r) => [r.id, r.name])),
  };
  loadedAt = Date.now();
  return cache;
}
export const clearRefCache = () => { cache = null; };
