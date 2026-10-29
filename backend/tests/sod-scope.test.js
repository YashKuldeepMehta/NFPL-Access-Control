import { describe, it, expect } from 'vitest';
import { as, plant, mkJob, uid, newUser, grant, pool } from './helpers/client.js';

const can = async (who, action, job) => (await as(who).get(`/can?action=${action}&job=${job}`)).body;
// An admin asking about someone else (needs access.view): works even for jobs that person cannot see.
const canFor = async (who, action, job) => (await as('vikram').get(`/can?user=${await uid(who)}&action=${action}&job=${job}`)).body;

describe('Q3 maker/checker conflict', () => {
  it('the preparer cannot check the same job, even though she is a qualified Checker', async () => {
    const job = await plant('SOD_DEMO');
    const asha = await can('asha', 'job.check', job.id);
    expect(asha.allowed).toBe(false);
    expect(asha.reason_code).toBe('SOD_VIOLATION');
    expect(asha.checks.find((c) => c.name === 'separation_of_duties').pass).toBe(false);
    expect((await can('ravi', 'job.check', job.id)).allowed).toBe(true);
  });
  it('the same Checker CAN check an Acme job someone else prepared', async () => {
    const id = await mkJob({ steps: [['job.prepare', 'pooja', 5]] });
    expect((await can('asha', 'job.check', id)).allowed).toBe(true);
  });
  it('executing it: Asha is refused (and the refusal is audited), Ravi succeeds', async () => {
    const job = await plant('SOD_DEMO');
    const denied = await as('asha').post(`/jobs/${job.id}/actions/job.check`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('SOD_VIOLATION');
    const a = await pool.query(`SELECT 1 FROM audit_log WHERE job_id=$1 AND event='access.denied' AND reason_code='SOD_VIOLATION'`, [job.id]);
    expect(a.rowCount).toBeGreaterThan(0);
    const id = await mkJob({ steps: [['job.prepare', 'asha', 5]] });
    const ok = await as('ravi').post(`/jobs/${id}/actions/job.check`);
    expect(ok.status).toBe(200);
    expect(ok.body.stage).toBe('checked');
    expect(ok.body.checked_by).toBe(await uid('ravi'));
  });
  it('the checker cannot file the same job', async () => {
    const maker = await newUser(); const both = await newUser();
    await grant(maker.id, 'maker', { branch: 'MUM' });
    await grant(both.id, 'checker', { branch: 'MUM' });
    await grant(both.id, 'filer', { branch: 'MUM' });
    const id = await mkJob({ steps: [['job.prepare', maker.id, 5]] });
    expect((await as(both.key).post(`/jobs/${id}/actions/job.check`)).status).toBe(200);
    const file = await as(both.key).post(`/jobs/${id}/actions/job.file`);
    expect(file.status).toBe(403);
    expect(file.body.error.code).toBe('SOD_VIOLATION');
  });
});

describe('Q2 scoped roles', () => {
  it('Asha is Maker everywhere but Checker only for Acme and Bolt', async () => {
    const everest = await mkJob({ client: 'EVEREST', branch: 'AMD', direction: 'export', mode: 'lcl' });
    expect((await can('asha', 'job.prepare', everest)).allowed).toBe(true);
    const cobaltPrepared = await mkJob({ client: 'COBALT', steps: [['job.prepare', 'pooja', 5]] });
    const r = await can('asha', 'job.check', cobaltPrepared);
    expect(r.allowed).toBe(false);
    expect(r.reason_code).toBe('OUT_OF_SCOPE');
    const boltPrepared = await mkJob({ client: 'BOLT', steps: [['job.prepare', 'pooja', 5]] });
    expect((await can('asha', 'job.check', boltPrepared)).allowed).toBe(true);
  });
  it('Ravi: Checker for Acme + Mumbai + imports only', async () => {
    const mk = (o) => mkJob({ steps: [['job.prepare', 'pooja', 5]], ...o });
    expect((await canFor('ravi', 'job.check', await mk({}))).allowed).toBe(true);
    expect((await canFor('ravi', 'job.check', await mk({ direction: 'export' }))).reason_code).toBe('OUT_OF_SCOPE');
    expect((await canFor('ravi', 'job.check', await mk({ branch: 'DEL' }))).reason_code).toBe('OUT_OF_SCOPE');
    expect((await canFor('ravi', 'job.check', await mk({ client: 'BOLT' }))).reason_code).toBe('OUT_OF_SCOPE');
    // and Ravi himself gets a 404: he cannot even see an export job
    expect((await as('ravi').get(`/can?action=job.check&job=${await mk({ direction: 'export' })}`)).status).toBe(404);
  });
  it('the access endpoint states it in plain terms', async () => {
    const r = await as('vikram').get(`/users/${await uid('asha')}/access`);
    expect(r.body.grants.map((g) => g.description)).toContain(
      'Asha Kulkarni has role Checker for client Acme, all branches, all directions, all modes.');
  });
});

describe('Q1 see vs act', () => {
  it('a person cannot even see jobs outside the scopes of their grants (404, existence not leaked)', async () => {
    const u = await newUser();
    await grant(u.id, 'checker', { client: 'ACME', branch: 'MUM' });
    const other = await mkJob({ client: 'COBALT', branch: 'KOL' });
    expect((await as(u.key).get(`/jobs/${other}`)).status).toBe(404);
    const mine = await mkJob({ client: 'ACME', branch: 'MUM' });
    const r = await as(u.key).get(`/jobs/${mine}`);
    expect(r.status).toBe(200);
    expect(r.body.access.actions.find((a) => a.action === 'job.prepare')).toBeUndefined(); // sees it, cannot prepare it
  });
});
