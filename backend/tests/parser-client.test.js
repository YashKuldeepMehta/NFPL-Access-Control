import { describe, it, expect } from 'vitest';
import { as, mkJob, plant, uid, clientId, branchId, getJob } from './helpers/client.js';

describe('Q9 the overnight parser', () => {
  it('may create and update jobs (while early-stage)', async () => {
    const r = await as('parser').post('/jobs', { client_id: await clientId('HELIX'), branch_id: await branchId('AMD'), direction: 'import', mode: 'lcl', internal_notes: 'parsed' });
    expect(r.status).toBe(201);
    expect(r.body.stage).toBe('confirmed');
    expect(r.body.created_by).toBe(await uid('parser'));
    const u = await as('parser').patch(`/jobs/${r.body.id}`, { customs_ref: 'BOE-9' });
    expect(u.status).toBe(200);
  });
  it('can NOT prepare, check, file, cancel, reopen, reassign or approve', async () => {
    const id = await mkJob({ steps: [['job.prepare', 'asha', 5]] });
    for (const action of ['job.prepare', 'job.check', 'job.file', 'job.cancel', 'job.cancel_filed', 'job.reopen', 'job.reassign', 'job.admin_fix', 'job.approve_dangerous']) {
      const r = (await as('parser').get(`/can?action=${action}&job=${id}`)).body;
      expect(r.allowed, action).toBe(false);
    }
  });
  it('cannot update a job once it is past the early stages', async () => {
    const id = await mkJob({ steps: [['job.prepare', 'asha', 5]] });
    const r = await as('parser').patch(`/jobs/${id}`, { customs_ref: 'late edit' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('STAGE_NOT_ALLOWED');
  });
  it('has an empty worklist and cannot be given a human role', async () => {
    expect((await as('parser').get('/me/worklist/count')).body.count).toBe(0);
    const r = await as('vikram').post('/grants', { user_id: await uid('parser'), role_code: 'maker', reason: 'try' });
    expect(r.body.error.code).toBe('ACTOR_TYPE_MISMATCH');
  });
});

describe('Q7 a client\'s own employee', () => {
  it('sees only their own client, read-only, without internal fields', async () => {
    const list = (await as('zoya').get('/jobs?limit=200')).body.items;
    expect(list.length).toBeGreaterThan(0);
    const acme = await clientId('ACME');
    expect(list.every((j) => j.client_id === acme)).toBe(true);
    expect(list.every((j) => j.internal_notes === undefined && j.owner_id === undefined && j.redacted === true)).toBe(true);
    const bolt = await mkJob({ client: 'BOLT' });
    expect((await as('zoya').get(`/jobs/${bolt}`)).status).toBe(404);
    expect((await as('kiran').get(`/jobs/${bolt}`)).status).toBe(200);
  });
  it('cannot act, cannot see history, has no worklist', async () => {
    const job = await plant('SOD_DEMO');
    expect((await as('zoya').post(`/jobs/${job.id}/actions/job.check`)).status).toBe(403);
    expect((await as('zoya').get(`/jobs/${job.id}/history`)).status).toBe(403);
    expect((await as('zoya').patch(`/jobs/${job.id}`, { customs_ref: 'x' })).status).toBe(403);
    expect((await as('zoya').get('/me/worklist/count')).body.count).toBe(0);
  });
  it('staff see internal fields', async () => {
    const job = await plant('SOD_DEMO');
    const r = await as('asha').get(`/jobs/${job.id}`);
    expect(r.body.job.internal_notes).toContain('PLANT');
    expect(r.body.job.redacted).toBeUndefined();
  });
});
