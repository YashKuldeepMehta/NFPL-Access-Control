// Loads the small, deliberate sample data set:  npm run seed
// 5 branches, 10 clients, 20 named users (+1 bootstrap actor), ~250 jobs with history, and the awkward cases on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJobWithHistory } from './lib.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;

const BRANCHES = [['MUM', 'Mumbai'], ['DEL', 'Delhi'], ['CHN', 'Chennai'], ['KOL', 'Kolkata'], ['AMD', 'Ahmedabad']];
const CLIENTS = [['ACME', 'Acme'], ['BOLT', 'Bolt'], ['COBALT', 'Cobalt'], ['DELTA', 'Delta'], ['EVEREST', 'Everest'],
  ['FALCON', 'Falcon'], ['GRANITE', 'Granite'], ['HELIX', 'Helix'], ['INDUS', 'Indus'], ['JUPITER', 'Jupiter']];

// key, display name, type, client code (client users only)
const USERS = [
  ['asha', 'Asha Kulkarni', 'staff'], ['ravi', 'Ravi Menon', 'staff'], ['meera', 'Meera Iyer', 'staff'],
  ['karan', 'Karan Shah', 'staff'], ['neha', 'Neha Gupta', 'staff'], ['dev', 'Dev Patel', 'staff'],
  ['sunita', 'Sunita Rao', 'staff'], ['rajesh', 'Rajesh Nair', 'staff'], ['vikram', 'Vikram Singh', 'staff'],
  ['zoya', 'Zoya Khan', 'client', 'ACME'], ['kiran', 'Kiran Desai', 'client', 'BOLT'],
  ['parser', 'Overnight Parser', 'system'],
  ['pooja', 'Pooja Reddy', 'staff'], ['imran', 'Imran Qureshi', 'staff'], ['anita', 'Anita Joshi', 'staff'],
  ['suresh', 'Suresh Bhat', 'staff'], ['lata', 'Lata Pillai', 'staff'], ['farhan', 'Farhan Ali', 'staff'],
  ['tina', "Tina D'Souza", 'staff'], ['manoj', 'Manoj Verma', 'staff'],
  ['bootstrap', 'System Bootstrap', 'system'],
];

export const emailOf = (key) => `${key}@nfpl.test`;

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export async function seed(pool) {
  const db = await pool.connect();
  const now = new Date();
  const ago = (days) => new Date(now.getTime() - days * DAY);
  const rand = mulberry32(42);
  try {
    await db.query('BEGIN');
    await db.query(`TRUNCATE audit_log, approval_requests, absences, grants, jobs, role_permissions, role_grant_rights, role_conflicts,
      roles, permissions, job_transitions, action_stages, sod_rules, users, clients, branches RESTART IDENTITY CASCADE`);
    await db.query('ALTER SEQUENCE job_no_seq RESTART WITH 1');
    await db.query(fs.readFileSync(path.join(here, 'reference.sql'), 'utf8'));

    // --- reference entities ---
    const branchId = {}; const clientId = {}; const uid = {};
    for (const [code, name] of BRANCHES) branchId[code] = (await db.query('INSERT INTO branches (code, name) VALUES ($1,$2) RETURNING id', [code, name])).rows[0].id;
    for (const [code, name] of CLIENTS) clientId[code] = (await db.query('INSERT INTO clients (code, name) VALUES ($1,$2) RETURNING id', [code, name])).rows[0].id;
    for (const [key, name, type, client] of USERS) {
      uid[key] = (await db.query('INSERT INTO users (name, email, type, client_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [name, emailOf(key), type, client ? clientId[client] : null])).rows[0].id;
    }

    // --- grants: every person's access, in data ---
    const grants = [
      { user: 'asha', role: 'maker' },                                   // Maker for EVERYTHING ...
      { user: 'asha', role: 'checker', client: 'ACME' },                 // ... but Checker only for Acme
      { user: 'asha', role: 'checker', client: 'BOLT' },                 // ... and Bolt
      { user: 'ravi', role: 'checker', client: 'ACME', branch: 'MUM', direction: 'import' }, // narrow slice
      { user: 'meera', role: 'maker', branch: 'DEL' },                   // absent (delegate: Karan)
      { user: 'karan', role: 'maker', branch: 'CHN' },
      { user: 'neha', role: 'filer', branch: 'MUM' },
      { user: 'dev', role: 'supervisor', branch: 'MUM' },
      { user: 'sunita', role: 'controller' }, { user: 'rajesh', role: 'controller' },
      { user: 'vikram', role: 'access_admin' },
      { user: 'zoya', role: 'client_viewer', client: 'ACME' },           // client-side user
      { user: 'kiran', role: 'client_viewer', client: 'BOLT' },
      { user: 'parser', role: 'system_parser' },                         // the overnight parser
      { user: 'pooja', role: 'maker', branch: 'KOL' }, { user: 'suresh', role: 'maker', branch: 'AMD' },
      { user: 'imran', role: 'checker', branch: 'CHN' }, { user: 'imran', role: 'checker', branch: 'KOL' }, { user: 'imran', role: 'checker', branch: 'AMD' },
      { user: 'lata', role: 'checker', branch: 'DEL' },                  // absent, nobody covering
      { user: 'anita', role: 'filer', branch: 'DEL' }, { user: 'anita', role: 'filer', branch: 'AMD' },
      { user: 'farhan', role: 'filer', branch: 'CHN' }, { user: 'farhan', role: 'filer', branch: 'KOL' },
      { user: 'tina', role: 'checker', client: 'COBALT', from: -60, to: -10, endedBy: 'vikram', endReason: 'Moved to the Delta account' }, // ended grant (history!)
      { user: 'tina', role: 'checker', client: 'DELTA', from: -10 },
      { user: 'manoj', role: 'supervisor', branch: 'KOL' },
    ].map((g) => ({ from: -60, to: null, ...g }));
    const gFrom = (g) => ago(-g.from);
    const gTo = (g) => (g.to == null ? null : ago(-g.to));
    for (const g of grants) {
      await db.query(
        `INSERT INTO grants (user_id, role_id, client_id, branch_id, direction, mode, valid_from, valid_to, reason, granted_by, ended_by, end_reason)
         VALUES ($1,(SELECT id FROM roles WHERE code=$2),$3,$4,$5,$6,$7,$8,'Initial sample data',$9,$10,$11)`,
        [uid[g.user], g.role, g.client ? clientId[g.client] : null, g.branch ? branchId[g.branch] : null, g.direction ?? null, g.mode ?? null,
         gFrom(g), gTo(g), uid.bootstrap, g.endedBy ? uid[g.endedBy] : null, g.endReason ?? null]);
    }
    // --- absences ---
    const absences = [
      { user: 'meera', delegate: 'karan', from: -1, to: 7, reason: 'On leave' },   // absent, COVERED
      { user: 'lata', delegate: null, from: -1, to: 14, reason: 'On leave' },      // absent, NOBODY covering
    ];
    for (const a of absences) {
      await db.query(`INSERT INTO absences (user_id, delegate_id, valid_from, valid_to, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [uid[a.user], a.delegate ? uid[a.delegate] : null, ago(-a.from), ago(-a.to), a.reason, uid.sunita]);
    }

    // --- sample-time eligibility, used only to build a believable history (NOT the engine) ---
    const absent = (u, at) => absences.some((a) => a.user === u && at >= ago(-a.from) && at < ago(-a.to));
    const covers = (g, j) => (!g.client || g.client === j.client) && (!g.branch || g.branch === j.branch)
      && (!g.direction || g.direction === j.direction) && (!g.mode || g.mode === j.mode);
    const pick = (role, j, at, exclude = []) => {
      const c = [...new Set(grants.filter((g) => g.role === role && covers(g, j) && at >= gFrom(g) && (!gTo(g) || at < gTo(g))
        && !exclude.includes(g.user) && !absent(g.user, at)).map((g) => g.user))];
      return c.length ? c[Math.floor(rand() * c.length)] : null;
    };
    const ids = (j) => ({ client_id: clientId[j.client], branch_id: branchId[j.branch], direction: j.direction, mode: j.mode });

    // --- planted jobs: the awkward cases, on purpose ---
    const P = (note, j, createdBy, createdDaysAgo, steps = [], extra = {}) => createJobWithHistory(db, {
      ...ids(j), created_by: uid[createdBy], created_at: ago(createdDaysAgo), internal_notes: `PLANT:${note}`,
      steps: steps.map(([action, actor, daysAgo, more]) => ({ action, actor: uid[actor], at: ago(daysAgo), ...(more ?? {}) })),
      ...extra,
    });
    const acmeMum = (direction, mode) => ({ client: 'ACME', branch: 'MUM', direction, mode });
    await P('SOD_DEMO', acmeMum('import', 'air'), 'asha', 3, [['job.prepare', 'asha', 2.9]]);                // Asha prepared it: SoD blocks her; Ravi may check
    await P('FILED_ACME', acmeMum('import', 'fcl'), 'parser', 7,
      [['job.prepare', 'asha', 6], ['job.check', 'ravi', 5], ['job.file', 'neha', 4]], { customs_ref: 'BOE-100001' });                     // filed: cancel/reopen demo
    await P('STUCK_NO_CHECKER', acmeMum('export', 'air'), 'asha', 5, [['job.prepare', 'asha', 4.9]]);        // nobody can check it
    await P('ABSENT_OWNER', { client: 'COBALT', branch: 'DEL', direction: 'import', mode: 'lcl' }, 'parser', 2, [],
      { owner_id: uid.meera, owner_set_at: ago(1.5), assigned_by: uid.sunita });                             // owner absent, delegate covers
    await P('UNATTENDED', { client: 'COBALT', branch: 'DEL', direction: 'export', mode: 'fcl' }, 'parser', 5, [['job.prepare', 'meera', 4]],
      { owner_id: uid.lata, owner_set_at: ago(3), assigned_by: uid.sunita });                                // owner absent, NOBODY covers
    await P('PARSER_NEW', acmeMum('import', 'air'), 'parser', 0.25);                                          // created overnight by the parser
    await P('COBALT_HISTORY', { client: 'COBALT', branch: 'KOL', direction: 'export', mode: 'air' }, 'parser', 17,
      [['job.prepare', 'pooja', 16]]);                                                                       // Tina could check it 15 days ago, not now
    await P('DELTA_PREPARED', { client: 'DELTA', branch: 'MUM', direction: 'import', mode: 'fcl' }, 'asha', 3, [['job.prepare', 'asha', 2]]);

    // --- ~250 random jobs with a believable workflow history ---
    const STAGES = [['confirmed', 0.2], ['prepared', 0.25], ['checked', 0.15], ['filed', 0.25], ['cancelled', 0.08], ['reopened', 0.07]];
    const target = () => { let r = rand(); for (const [s, w] of STAGES) { if ((r -= w) < 0) return s; } return 'confirmed'; };
    const oneOf = (arr) => arr[Math.floor(rand() * arr.length)];
    for (let n = 0; n < 250; n++) {
      const j = { client: oneOf(CLIENTS)[0], branch: oneOf(BRANCHES)[0], direction: oneOf(['import', 'export']), mode: oneOf(['air', 'fcl', 'lcl']) };
      const created = new Date(now.getTime() - (2 + rand() * 42) * DAY);
      const createdBy = rand() < 0.6 ? 'parser' : (pick('maker', j, created) ?? 'parser');
      let t = created; const steps = [];
      const next = () => { t = new Date(Math.min(t.getTime() + (1 + rand() * 30) * 3_600_000, now.getTime() - 3_600_000)); return t; };
      const step = (action, role, exclude) => { const at = next(); const actor = pick(role, j, at, exclude); if (!actor) return null;
        steps.push({ action, actor: uid[actor], at }); return actor; };
      const goal = target();
      let preparer = null; let checker = null;
      if (goal !== 'confirmed') {
        preparer = step('job.prepare', 'maker');
        if (preparer && goal === 'cancelled') {
          const at = next(); const who = pick('supervisor', j, at) ?? pick('controller', j, at);
          if (who) steps.push({ action: 'job.cancel', actor: uid[who], at, reason: 'Client requested cancellation' });
        } else if (preparer && goal !== 'prepared') {
          checker = step('job.check', 'checker', [preparer]);
          if (checker && goal !== 'checked') {
            const filer = step('job.file', 'filer', [checker]);
            if (filer && goal === 'reopened') {
              const r0 = next(); const r1 = new Date(r0.getTime() + 3_600_000); const r2 = new Date(r1.getTime() + 3_600_000);
              steps.push({ action: 'job.reopen', actor: uid.sunita, at: r2, reason: 'Customs query: corrected invoice value',
                approval: { requested_by: uid.sunita, decided_by: uid.rajesh, requested_at: r0, decided_at: r1, reason: 'Customs query: corrected invoice value' } });
              t = r2;
            }
          }
        }
      }
      const final = steps.length ? { filed: steps.some((s) => s.action === 'job.file') } : {};
      const spec = { ...ids(j), created_by: uid[createdBy], created_at: created, internal_notes: 'Sample job',
        customs_ref: final.filed ? `BOE-${200000 + n}` : null, steps };
      // ~30% of open jobs are assigned to someone who can do the next step
      const lastStage = steps.length ? { 'job.prepare': 'prepared', 'job.check': 'checked', 'job.file': 'filed', 'job.cancel': 'cancelled', 'job.reopen': 'reopened' }[steps[steps.length - 1].action] : 'confirmed';
      const roleNext = { confirmed: 'maker', reopened: 'maker', prepared: 'checker', checked: 'filer' }[lastStage];
      if (roleNext && rand() < 0.3) {
        const excl = lastStage === 'prepared' ? [preparer] : lastStage === 'checked' ? [checker] : [];
        const owner = pick(roleNext, j, now, excl);
        if (owner) { spec.owner_id = uid[owner]; spec.owner_set_at = new Date(Math.min(t.getTime() + 3_600_000, now.getTime())); spec.assigned_by = uid.sunita; }
      }
      await createJobWithHistory(db, spec);
    }

    await db.query('COMMIT');
    const c = (await pool.query(`SELECT (SELECT count(*) FROM jobs)::int AS jobs, (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM grants)::int AS grants, (SELECT count(*) FROM audit_log)::int AS audit`)).rows[0];
    return c;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  } finally {
    db.release();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { pool } = await import('../src/db.js');
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
    const c = await seed(pool);
    console.log(`Sample data loaded: ${c.users} users, ${c.grants} grants, ${c.jobs} jobs, ${c.audit} audit rows.`);
    console.log('Next: npm run readme:access   (prints every person\'s access in plain language)');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
