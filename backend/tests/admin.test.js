import { describe, it, expect } from 'vitest';
import { as, mkJob, getJob, uid, newUser, grant, clientId, branchId, pool, FILED } from './helpers/client.js';

describe('Q8 admin: fix a stuck job, but never escalate', () => {
  it('cannot grant themselves anything (and the attempt is audited)', async () => {
    const vikram = await uid('vikram');
    const r = await as('vikram').post('/grants', { user_id: vikram, role_code: 'maker', reason: 'give me more power' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SELF_GRANT');
    const a = await pool.query(`SELECT 1 FROM audit_log WHERE actor_id=$1 AND event='access.denied' AND reason_code='SELF_GRANT'`, [vikram]);
    expect(a.rowCount).toBeGreaterThan(0);
  });
  it('the database itself refuses a self-grant, even if the code were buggy', async () => {
    const u = await newUser();
    await expect(pool.query(`INSERT INTO grants (user_id, role_id, reason, granted_by) VALUES ($1,(SELECT id FROM roles WHERE code='maker'),'x',$1)`, [u.id])).rejects.toThrow();
  });
  it('cannot hand out Controller or Access Admin (only the bootstrap CLI can)', async () => {
    const u = await newUser();
    for (const role_code of ['controller', 'access_admin']) {
      const r = await as('vikram').post('/grants', { user_id: u.id, role_code, reason: 'try' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('NO_AUTHORITY');
    }
  });
  it('role/actor-type rules: no Maker for a client user; client users stay inside their own client', async () => {
    const zoya = await uid('zoya');
    const maker = await as('vikram').post('/grants', { user_id: zoya, role_code: 'maker', reason: 'try' });
    expect(maker.body.error.code).toBe('ACTOR_TYPE_MISMATCH');
    const wrongClient = await as('vikram').post('/grants', { user_id: zoya, role_code: 'client_viewer', client_id: await clientId('BOLT'), reason: 'try' });
    expect(wrongClient.body.error.code).toBe('CLIENT_SCOPE_VIOLATION');
  });
  it('conflicting roles are refused (an Access Admin cannot also be a Maker)', async () => {
    const admin2 = await newUser();
    await grant(admin2.id, 'access_admin');
    const r = await as('vikram').post('/grants', { user_id: admin2.id, role_code: 'maker', reason: 'try' });
    expect(r.body.error.code).toBe('CONFLICTING_ROLE');
  });
  it('a branch-scoped admin cannot widen beyond their own branch', async () => {
    const branchAdmin = await newUser(); const target = await newUser();
    await grant(branchAdmin.id, 'access_admin', { branch: 'MUM' });
    const wide = await as(branchAdmin.key).post('/grants', { user_id: target.id, role_code: 'maker', reason: 'all branches' });
    expect(wide.body.error.code).toBe('SCOPE_WIDENING');
    const ok = await as(branchAdmin.key).post('/grants', { user_id: target.id, role_code: 'maker', branch_id: await branchId('MUM'), reason: 'Mumbai only' });
    expect(ok.status).toBe(201);
  });
  it('cannot end their own grant', async () => {
    const mine = await pool.query(`SELECT id FROM grants WHERE user_id = $1`, [await uid('vikram')]);
    const r = await as('vikram').post(`/grants/${mine.rows[0].id}/end`, { reason: 'try' });
    expect(r.body.error.code).toBe('SELF_REVOKE');
  });
  it('an admin has no routine job powers and sees no internal fields', async () => {
    const id = await mkJob({ steps: [['job.prepare', 'asha', 5]] });
    expect((await as('vikram').get(`/can?action=job.check&job=${id}`)).body.allowed).toBe(false);
    const j = await as('vikram').get(`/jobs/${id}`);
    expect(j.body.job.redacted).toBe(true);
    expect(j.body.job.internal_notes).toBeUndefined();
  });
  it('fixing a stuck job: audited, reason required, can only send BACK, never forward, never when filed', async () => {
    const stuck = await mkJob({ steps: [['job.prepare', 'asha', 9], ['job.check', 'ravi', 8]] });   // checked
    expect((await as('vikram').post(`/jobs/${stuck}/admin-fix`, { to_stage: 'prepared' })).status).toBe(400);   // no reason
    const fix = await as('vikram').post(`/jobs/${stuck}/admin-fix`, { to_stage: 'prepared', reason: 'Wrong checker ticked it' });
    expect(fix.status).toBe(200);
    expect(fix.body.stage).toBe('prepared');
    expect(fix.body.checked_by).toBeNull();
    const fwd = await as('vikram').post(`/jobs/${stuck}/admin-fix`, { to_stage: 'checked', reason: 'skip the checker' });
    expect(fwd.body.error.code).toBe('ADMIN_CANNOT_ADVANCE');
    const filed = await mkJob({ steps: FILED });
    const f = await as('vikram').post(`/jobs/${filed}/admin-fix`, { to_stage: 'prepared', reason: 'unfile it' });
    expect(f.body.error.code).toBe('STAGE_NOT_ALLOWED');
    expect((await getJob(filed)).stage).toBe('filed');
    const ev = await pool.query(`SELECT detail FROM audit_log WHERE job_id=$1 AND event='job.admin_fix'`, [stuck]);
    expect(ev.rows[0].detail.override).toBe(true);
  });
});
