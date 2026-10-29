import { describe, it, expect } from 'vitest';
import { as, plant, mkJob, uid, newUser, grant, pool } from './helpers/client.js';

const canFor = async (who, action, job) => (await as('vikram').get(`/can?user=${await uid(who)}&action=${action}&job=${job}`)).body;
const iso = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

describe('Q4 absent owner', () => {
  it('delegate covers: Karan can prepare in Delhi through Meera; Meera cannot while absent', async () => {
    const job = await plant('ABSENT_OWNER');
    const karan = await canFor('karan', 'job.prepare', job.id);
    expect(karan.allowed).toBe(true);
    expect(karan.reason_code).toBe('ALLOWED_VIA_DELEGATION');
    expect(karan.grant.via_name).toBe('Meera Iyer');
    const meera = await canFor('meera', 'job.prepare', job.id);
    expect(meera.allowed).toBe(false);
    expect(meera.reason_code).toBe('USER_ABSENT');
  });
  it('the delegate acts and the audit trail says "on behalf of"', async () => {
    const id = await mkJob({ client: 'EVEREST', branch: 'DEL', direction: 'export' });
    const r = await as('karan').post(`/jobs/${id}/actions/job.prepare`);
    expect(r.status).toBe(200);
    const a = await pool.query(`SELECT on_behalf_of FROM audit_log WHERE job_id=$1 AND event='job.transition'`, [id]);
    expect(a.rows[0].on_behalf_of).toBe(await uid('meera'));
  });
  it('the delegate stays bound by separation of duties (cannot launder a conflict through the absent person)', async () => {
    const absent = await newUser(); const cover = await newUser();
    await grant(absent.id, 'maker', { branch: 'DEL' });
    await grant(absent.id, 'checker', { branch: 'DEL' });     // the absent person could prepare AND check ...
    await grant(cover.id, 'filer', { branch: 'DEL' });        // ... the delegate has no Checker role of their own
    await pool.query(`INSERT INTO absences (user_id, delegate_id, valid_from, valid_to, reason, created_by) VALUES ($1,$2, now() - interval '1 hour', now() + interval '1 day', 'test', $3)`,
      [absent.id, cover.id, await uid('sunita')]);
    const id = await mkJob({ branch: 'DEL', steps: [['job.prepare', absent.id, 5]] });   // absent person prepared it
    const r = await as(cover.key).get(`/can?action=job.check&job=${id}`);
    expect(r.body.allowed).toBe(false);                        // checking through them would let them check their own work
    expect(r.body.reason_code).toBe('SOD_VIOLATION');
    // someone else's job is fine: delegation really does work
    const other = await mkJob({ branch: 'DEL', steps: [['job.prepare', 'meera', 5]] });
    const ok = await as(cover.key).get(`/can?action=job.check&job=${other}`);
    expect(ok.body.allowed).toBe(true);
    expect(ok.body.reason_code).toBe('ALLOWED_VIA_DELEGATION');
  });
  it('nobody covering: the job shows up as unattended for people who may reassign', async () => {
    const job = await plant('UNATTENDED');
    const r = await as('sunita').get('/me/unattended?limit=200');
    const hit = r.body.items.find((j) => j.id === job.id);
    expect(hit.unattended_reason).toBe('OWNER_ABSENT_NO_DELEGATE');
    // Meera's job is NOT unattended: her delegate covers
    const covered = await plant('ABSENT_OWNER');
    expect(r.body.items.find((j) => j.id === covered.id)).toBeUndefined();
  });
  it('a supervisor can only record absences inside their own scope; a controller can reassign', async () => {
    const delhiMaker = await newUser(); const other = await newUser();
    await grant(delhiMaker.id, 'maker', { branch: 'DEL' });
    const body = { user_id: delhiMaker.id, delegate_id: other.id, valid_from: iso(1), valid_to: iso(48), reason: 'leave' };
    const dev = await as('dev').post('/absences', body);               // Dev supervises Mumbai only
    expect(dev.status).toBe(403);
    expect(dev.body.error.code).toBe('SCOPE_WIDENING');
    const ok = await as('sunita').post('/absences', body);             // Controller: all branches
    expect(ok.status).toBe(201);
    const end = await as('sunita').post(`/absences/${ok.body.id}/end`);
    expect(end.status).toBe(200);
  });
  it('reassigning an unattended job: only to someone who can do the next step', async () => {
    const job = await plant('UNATTENDED');            // prepared, Delhi, Cobalt: next step is CHECK
    const bad = await as('sunita').post(`/jobs/${job.id}/reassign`, { owner_id: await uid('neha') });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('ASSIGNEE_NOT_ELIGIBLE');
    const fix = await newUser();
    await grant(fix.id, 'checker', { branch: 'DEL' });
    const ok = await as('sunita').post(`/jobs/${job.id}/reassign`, { owner_id: fix.id, reason: 'Lata is on leave' });
    expect(ok.status).toBe(200);
    expect(ok.body.owner_id).toBe(fix.id);
    const again = await as('sunita').get('/me/unattended?limit=200');
    expect(again.body.items.find((j) => j.id === job.id)).toBeUndefined();
  });
});
