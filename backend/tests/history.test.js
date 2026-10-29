import { describe, it, expect } from 'vitest';
import { as, plant, uid } from './helpers/client.js';

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString();
const names = (r) => r.body.who.map((w) => w.name);

describe('Q11 who could have changed this job on the 3rd?', () => {
  it('uses the grants that were valid THEN, not today\'s', async () => {
    const job = await plant('COBALT_HISTORY');            // Cobalt / Kolkata, prepared 16 days ago, still waiting for a check
    const q = (at) => as('vikram').get(`/jobs/${job.id}/who-could-act?action=job.check&at=${encodeURIComponent(at)}`);
    const then = await q(daysAgo(15));
    expect(then.body.state.stage).toBe('prepared');
    expect(names(then)).toEqual(expect.arrayContaining(["Tina D'Souza", 'Imran Qureshi']));
    expect(names(then)).not.toContain('Asha Kulkarni');   // Asha is a Checker for Acme/Bolt only
    const now = await q(new Date().toISOString());
    expect(names(now)).toContain('Imran Qureshi');
    expect(names(now)).not.toContain("Tina D'Souza");     // her Cobalt grant ended 10 days ago
  });
  it('before the job existed, nobody could have changed it', async () => {
    const job = await plant('COBALT_HISTORY');
    const r = await as('vikram').get(`/jobs/${job.id}/who-could-act?at=${encodeURIComponent(daysAgo(25))}`);
    expect(r.body.job_existed).toBe(false);
    expect(r.body.who).toEqual([]);
  });
  it('the stuck job: neither Asha (she prepared it) nor Ravi (imports only) could check it', async () => {
    const job = await plant('STUCK_NO_CHECKER');
    const r = await as('vikram').get(`/jobs/${job.id}/who-could-act?action=job.check&at=${encodeURIComponent(new Date().toISOString())}`);
    expect(names(r)).not.toContain('Asha Kulkarni');
    expect(names(r)).not.toContain('Ravi Menon');
  });
  it('needs audit.read', async () => {
    const job = await plant('COBALT_HISTORY');
    expect((await as('asha').get(`/jobs/${job.id}/who-could-act?at=${encodeURIComponent(daysAgo(1))}`)).status).toBe(403);
  });
});

describe('job history and Q10 "why can she and he can\'t?"', () => {
  it('a Supervisor can read a job\'s history; a client user cannot', async () => {
    const job = await plant('FILED_ACME');
    const r = await as('dev').get(`/jobs/${job.id}/history`);
    expect(r.status).toBe(200);
    expect(r.body.events.map((e) => e.event)).toEqual(['job.created', 'job.transition', 'job.transition', 'job.transition']);
    expect(r.body.events[1].summary).toContain('Asha Kulkarni');
    expect((await as('zoya').get(`/jobs/${job.id}/history`)).status).toBe(403);
  });
  it('compare: explains the first check where two people differ', async () => {
    const job = await plant('SOD_DEMO');
    const r = await as('vikram').get(`/explain/compare?a=${await uid('ravi')}&b=${await uid('asha')}&action=job.check&job=${job.id}`);
    expect(r.body.same_outcome).toBe(false);
    expect(r.body.a.allowed).toBe(true);
    expect(r.body.b.allowed).toBe(false);
    expect(r.body.difference.check).toBe('separation_of_duties');
    expect(r.body.sentence).toContain('Ravi Menon may job.check');
    const m = await as('vikram').get(`/explain/compare?a=${await uid('ravi')}&b=${await uid('meera')}&action=job.check&job=${job.id}`);
    expect(m.body.difference.check).toBe('grant_found');           // Meera is absent
    expect(m.body.b.reason_code).toBe('USER_ABSENT');
  });
  it('ordinary users cannot compare other people', async () => {
    const job = await plant('SOD_DEMO');
    expect((await as('asha').get(`/explain/compare?a=1&b=2&action=job.check&job=${job.id}`)).status).toBe(403);
    expect((await as('asha').get(`/can?user=${await uid('ravi')}&action=job.check&job=${job.id}`)).status).toBe(403);
  });
  it('the audit log is searchable by admins only', async () => {
    const r = await as('vikram').get('/audit?event=access.denied&limit=5');
    expect(r.status).toBe(200);
    expect((await as('asha').get('/audit')).status).toBe(403);
  });
});
