import { describe, it, expect } from 'vitest';
import { as, mkJob, uid, newUser, grant, clientId, branchId, getJob, pool } from './helpers/client.js';

describe('Q5 changed responsibility, and timing', () => {
  it('a grant takes effect immediately and ending it takes effect immediately', async () => {
    const u = await newUser();
    const id = await mkJob({ steps: [['job.prepare', 'asha', 5]] });
    expect((await as(u.key).get(`/jobs/${id}`)).status).toBe(404);                       // no access yet
    const g = await as('vikram').post('/grants', {
      user_id: u.id, role_code: 'checker', client_id: await clientId('ACME'), branch_id: await branchId('MUM'), reason: 'Covering Mumbai' });
    expect(g.status).toBe(201);
    expect((await as(u.key).get(`/can?action=job.check&job=${id}`)).body.allowed).toBe(true);   // effective at once
    expect((await as(u.key).get('/me/worklist?limit=200')).body.items.some((j) => j.id === id)).toBe(true);

    const end = await as('vikram').post(`/grants/${g.body.id}/end`, { reason: 'Moved to another team' });
    expect(end.status).toBe(200);
    expect((await as(u.key).get(`/jobs/${id}`)).status).toBe(404);                       // gone at once
    expect((await as(u.key).get('/me/worklist?limit=200')).body.items.some((j) => j.id === id)).toBe(false);
  });

  it('jobs halfway through keep their stage; the old owner is flagged as needing reassignment', async () => {
    const u = await newUser();
    const gid = await grant(u.id, 'checker', { client: 'ACME', branch: 'MUM' });
    const id = await mkJob({ steps: [['job.prepare', 'asha', 5]], owner: u.id });
    expect((await as('sunita').get('/me/unattended?limit=200')).body.items.some((j) => j.id === id)).toBe(false);
    await as('vikram').post(`/grants/${gid}/end`, { reason: 'Responsibilities changed' });
    expect((await getJob(id)).stage).toBe('prepared');                                   // stage untouched
    const un = (await as('sunita').get('/me/unattended?limit=200')).body.items.find((j) => j.id === id);
    expect(un.unattended_reason).toBe('OWNER_LOST_AUTHORITY');
    const denied = await as(u.key).get(`/can?action=job.check&job=${id}`);               // no longer visible to them
    expect(denied.status).toBe(404);
  });

  it('a future-dated grant does not apply until its start time', async () => {
    const u = await newUser();
    const id = await mkJob({ steps: [['job.prepare', 'asha', 5]] });
    const start = new Date(Date.now() + 3_600_000).toISOString();
    const g = await as('vikram').post('/grants', {
      user_id: u.id, role_code: 'checker', client_id: await clientId('ACME'), valid_from: start, reason: 'Starts next hour' });
    expect(g.status).toBe(201);
    expect((await as(u.key).get(`/jobs/${id}`)).status).toBe(404);
  });

  it('grants cannot be back-dated through the API', async () => {
    const u = await newUser();
    const r = await as('vikram').post('/grants', { user_id: u.id, role_code: 'checker', valid_from: '2020-01-01T00:00:00Z', reason: 'fake history' });
    expect(r.status).toBe(400);
  });

  it('someone leaves: disabling ends every grant and blocks every decision', async () => {
    const u = await newUser();
    await grant(u.id, 'maker', { branch: 'KOL' });
    await grant(u.id, 'checker', { branch: 'KOL' });
    const id = await mkJob({ branch: 'KOL' });
    expect((await as(u.key).get(`/can?action=job.prepare&job=${id}`)).body.allowed).toBe(true);
    const r = await as('vikram').post(`/users/${u.id}/disable`, { reason: 'Left the company' });
    expect(r.status).toBe(200);
    expect(r.body.grants_ended).toBe(2);
    expect((await as(u.key).get('/me')).status).toBe(403);                                // account disabled
    const viaAdmin = (await as('vikram').get(`/can?user=${u.id}&action=job.prepare&job=${id}`)).body;
    expect(viaAdmin.allowed).toBe(false);
    expect(viaAdmin.reason_code).toBe('USER_DISABLED');
  });
});
