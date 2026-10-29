// Generates the SCALE case (500 users, ~2,000 grants, 200,000 jobs) and times the list queries:  npm run seed:scale
// WARNING: wipes the database in DATABASE_URL (like `npm run seed`). Scale jobs have no audit history (kept small on purpose).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';
import { WORKLIST_COUNT_SQL, WORKLIST_PAGE_SQL, VISIBLE_JOBS_SQL, UNATTENDED_SQL } from '../src/engine/sql.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const JOBS = Number(process.env.SCALE_JOBS || 200_000);

async function timed(label, sql, params) {
  const t0 = performance.now();
  let rows = 0;
  for (let i = 0; i < 3; i++) rows = (await pool.query(sql, params)).rowCount;
  const wall = (performance.now() - t0) / 3;
  const plan = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
  const exec = plan.rows[0]['QUERY PLAN'][0]['Execution Time'];
  console.log(`${label.padEnd(52)} rows=${String(rows).padStart(4)}  db-exec=${exec.toFixed(1).padStart(7)} ms  end-to-end=${wall.toFixed(1).padStart(7)} ms`);
}

try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  console.log(`Generating 500 users and ${JOBS.toLocaleString()} jobs ... (this wipes ${new URL(process.env.DATABASE_URL).pathname})`);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`TRUNCATE audit_log, approval_requests, absences, grants, jobs, role_permissions, role_grant_rights, role_conflicts,
      roles, permissions, job_transitions, action_stages, sod_rules, users, clients, branches RESTART IDENTITY CASCADE`);
    await db.query('ALTER SEQUENCE job_no_seq RESTART WITH 1');
    await db.query(fs.readFileSync(path.join(here, 'reference.sql'), 'utf8'));
    await db.query(`
      INSERT INTO branches (code, name) VALUES ('MUM','Mumbai'),('DEL','Delhi'),('CHN','Chennai'),('KOL','Kolkata'),('AMD','Ahmedabad');
      INSERT INTO clients (code, name) SELECT 'C' || lpad(n::text, 3, '0'), 'Client ' || n FROM generate_series(1, 40) n;
      INSERT INTO users (name, email, type) VALUES ('System Bootstrap','bootstrap@nfpl.test','system'),   -- id 1
                                                   ('Overnight Parser','parser@nfpl.test','system'),     -- id 2
                                                   ('Scale Admin','admin@nfpl.test','staff'),            -- id 3
                                                   ('Controller One','controller1@nfpl.test','staff'),   -- id 4
                                                   ('Controller Two','controller2@nfpl.test','staff');   -- id 5
      INSERT INTO users (name, email, type) SELECT 'Staff ' || n, 'staff' || n || '@scale.test', 'staff' FROM generate_series(1, 455) n;       -- ids 6..460
      INSERT INTO users (name, email, type, client_id) SELECT 'Client user ' || n, 'client' || n || '@scale.test', 'client', n FROM generate_series(1, 40) n; -- ids 461..500

      INSERT INTO grants (user_id, role_id, reason, granted_by) VALUES
        (2, (SELECT id FROM roles WHERE code='system_parser'), 'scale data', 1),
        (3, (SELECT id FROM roles WHERE code='access_admin'),  'scale data', 1),
        (4, (SELECT id FROM roles WHERE code='controller'),    'scale data', 1),
        (5, (SELECT id FROM roles WHERE code='controller'),    'scale data', 1);
      INSERT INTO grants (user_id, role_id, client_id, reason, granted_by)
        SELECT u.id, (SELECT id FROM roles WHERE code='client_viewer'), u.client_id, 'scale data', 1 FROM users u WHERE u.type = 'client';

      -- first grant for every staff user (role by id), random scope; NULL = "all"
      INSERT INTO grants (user_id, role_id, client_id, branch_id, direction, mode, valid_from, reason, granted_by)
      SELECT u.id, r.id,
             CASE WHEN random() < 0.5 THEN NULL ELSE 1 + floor(random()*40)::int END,
             CASE WHEN random() < 0.3 THEN NULL ELSE 1 + floor(random()*5)::int END,
             CASE WHEN random() < 0.7 THEN NULL ELSE (ARRAY['import','export'])[1 + floor(random()*2)::int] END,
             CASE WHEN random() < 0.7 THEN NULL ELSE (ARRAY['air','fcl','lcl'])[1 + floor(random()*3)::int] END,
             now() - interval '90 days', 'scale data', 1
        FROM users u JOIN roles r ON r.code = (ARRAY['maker','checker','filer','maker'])[1 + (u.id % 4)]
       WHERE u.id BETWEEN 6 AND 460;
      -- second grant for half of them (different role)
      INSERT INTO grants (user_id, role_id, client_id, branch_id, direction, mode, valid_from, reason, granted_by)
      SELECT u.id, r.id,
             CASE WHEN random() < 0.5 THEN NULL ELSE 1 + floor(random()*40)::int END,
             CASE WHEN random() < 0.3 THEN NULL ELSE 1 + floor(random()*5)::int END,
             NULL, NULL, now() - interval '90 days', 'scale data', 1
        FROM users u JOIN roles r ON r.code = (ARRAY['checker','filer','maker','checker'])[1 + (u.id % 4)]
       WHERE u.id BETWEEN 6 AND 460 AND u.id % 2 = 0;
      -- a few supervisors
      INSERT INTO grants (user_id, role_id, branch_id, reason, granted_by)
        SELECT u.id, (SELECT id FROM roles WHERE code='supervisor'), 1 + (u.id % 5), 'scale data', 1 FROM users u WHERE u.id BETWEEN 6 AND 460 AND u.id % 45 = 0;
    `);
    await db.query(`
      INSERT INTO jobs (job_no, client_id, branch_id, direction, mode, stage, prepared_by, checked_by, filed_by, created_by, created_at, updated_at, internal_notes)
      SELECT 'NF-' || lpad(nextval('job_no_seq')::text, 6, '0'), y.c, y.b, y.d, y.m, y.st,
             CASE WHEN y.st IN ('prepared','checked','filed','reopened') THEN 6 + floor(random()*455)::int END,
             CASE WHEN y.st IN ('checked','filed') THEN 6 + floor(random()*455)::int END,
             CASE WHEN y.st = 'filed' THEN 6 + floor(random()*455)::int END,
             2, now() - (random() * interval '60 days'), now(), 'scale job'
        FROM (SELECT 1 + floor(random()*40)::int AS c, 1 + floor(random()*5)::int AS b,
                     (ARRAY['import','export'])[1 + floor(random()*2)::int] AS d,
                     (ARRAY['air','fcl','lcl'])[1 + floor(random()*3)::int] AS m,
                     CASE WHEN x.r < .25 THEN 'confirmed' WHEN x.r < .45 THEN 'prepared' WHEN x.r < .60 THEN 'checked'
                          WHEN x.r < .90 THEN 'filed' WHEN x.r < .95 THEN 'cancelled' ELSE 'reopened' END AS st
                FROM (SELECT random() AS r FROM generate_series(1, ${JOBS})) x) y`);
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  await pool.query('ANALYZE');

  const c = (await pool.query(`SELECT (SELECT count(*) FROM users)::int u, (SELECT count(*) FROM grants)::int g, (SELECT count(*) FROM jobs)::int j`)).rows[0];
  console.log(`Loaded: ${c.u} users, ${c.g} grants, ${c.j.toLocaleString()} jobs.\n`);

  // broadest Maker / Checker / Filer by number of matching worklist jobs, a typical one, a controller and a client user
  const broad = async (role) => (await pool.query(
    `SELECT g.user_id FROM grants g JOIN roles r ON r.id = g.role_id
      WHERE r.code = $1 AND g.client_id IS NULL AND g.branch_id IS NULL AND g.direction IS NULL AND g.mode IS NULL LIMIT 1`, [role])).rows[0]?.user_id;
  const people = [['broadest Maker (all scope)', await broad('maker') ?? 6], ['broadest Checker (all scope)', await broad('checker') ?? 7],
    ['typical staff user', 100], ['Controller', 4], ['client user', 461]];
  console.log('Query timings (3 runs averaged; "db-exec" = EXPLAIN ANALYZE execution time; page = 50 rows):');
  for (const [label, uid] of people) {
    await timed(`worklist count        - ${label}`, WORKLIST_COUNT_SQL, [uid, null, 'any']);
    await timed(`worklist first page   - ${label}`, WORKLIST_PAGE_SQL, [uid, null, 'any', 0, 50]);
    await timed(`visible jobs page     - ${label}`, VISIBLE_JOBS_SQL, [uid, null, 0, 50, null, null, null]);
  }
  await timed('unattended page         - Controller', UNATTENDED_SQL, [4, null, 0, 50]);
} catch (err) {
  console.error('Scale seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
