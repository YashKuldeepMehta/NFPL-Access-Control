import { describe, it, expect } from 'vitest';
import { as, mkJob, getJob, uid, pool, FILED } from './helpers/client.js';

describe('Q6 cancel a filed job / reopen a closed one', () => {
  it('cancel a filed job: needs Controller + reason + a SECOND person to approve', async () => {
    const id = await mkJob({ steps: FILED });
    // ordinary roles are refused outright
    for (const who of ['dev', 'neha', 'asha']) {
      const r = await as(who).post(`/jobs/${id}/actions/job.cancel_filed`, { reason: 'wrong shipment' });
      expect(r.status).toBe(403);
    }
    // a Controller still cannot just do it: no approval yet
    const direct = await as('sunita').post(`/jobs/${id}/actions/job.cancel_filed`, { reason: 'wrong shipment' });
    expect(direct.status).toBe(403);
    expect(direct.body.error.code).toBe('APPROVAL_REQUIRED');
    // a reason is mandatory to even ask
    expect((await as('sunita').post(`/jobs/${id}/approvals`, { action: 'job.cancel_filed' })).status).toBe(400);
    const req = await as('sunita').post(`/jobs/${id}/approvals`, { action: 'job.cancel_filed', reason: 'Client withdrew the shipment' });
    expect(req.status).toBe(201);
    // she cannot approve her own request; Dev (no approval right) cannot either
    expect((await as('sunita').post(`/approvals/${req.body.id}/decide`, { decision: 'approve' })).body.error.code).toBe('SELF_APPROVAL');
    expect((await as('dev').post(`/approvals/${req.body.id}/decide`, { decision: 'approve' })).status).toBe(403);
    // another Controller approves, then the requester executes
    expect((await as('rajesh').get('/me/approvals')).body.items.some((a) => a.id === req.body.id)).toBe(true);
    expect((await as('rajesh').post(`/approvals/${req.body.id}/decide`, { decision: 'approve', note: 'ok' })).body.status).toBe('approved');
    const done = await as('sunita').post(`/jobs/${id}/actions/job.cancel_filed`, { approval_id: req.body.id });
    expect(done.status).toBe(200);
    expect(done.body.stage).toBe('cancelled');
    // single use
    expect((await as('sunita').post(`/jobs/${id}/actions/job.cancel_filed`, { approval_id: req.body.id })).status).toBe(403);
    // the whole story is in the history
    const events = (await as('sunita').get(`/jobs/${id}/history`)).body.events.map((e) => e.event);
    expect(events).toEqual(expect.arrayContaining(['approval.requested', 'approval.decided', 'job.transition', 'access.denied']));
  });

  it('reopen a filed job: same two-person rule, and the reopened job is clean for re-work', async () => {
    const id = await mkJob({ steps: FILED });
    expect((await as('neha').post(`/jobs/${id}/actions/job.reopen`, { reason: 'filer tries reopen' })).status).toBe(403);   // Filer cannot
    expect((await as('asha').post(`/jobs/${id}/actions/job.reopen`, { reason: 'maker tries reopen' })).status).toBe(403);   // Maker cannot
    const req = await as('rajesh').post(`/jobs/${id}/approvals`, { action: 'job.reopen', reason: 'Customs query: invoice value' });
    expect((await as('sunita').post(`/approvals/${req.body.id}/decide`, { decision: 'approve' })).status).toBe(200);
    const r = await as('rajesh').post(`/jobs/${id}/actions/job.reopen`, { approval_id: req.body.id });
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe('reopened');
    const j = await getJob(id);
    expect(j.checked_by).toBeNull();
    expect(j.filed_by).toBeNull();
    // after a reopen, Asha (a Maker) can prepare it again
    expect((await as('asha').get(`/can?action=job.prepare&job=${id}`)).body.allowed).toBe(true);
  });

  it('an expired or someone-else\'s approval is refused', async () => {
    const id = await mkJob({ steps: FILED });
    const req = await as('sunita').post(`/jobs/${id}/approvals`, { action: 'job.cancel_filed', reason: 'Wrong client' });
    await as('rajesh').post(`/approvals/${req.body.id}/decide`, { decision: 'approve' });
    expect((await as('rajesh').post(`/jobs/${id}/actions/job.cancel_filed`, { approval_id: req.body.id })).body.error.code).toBe('APPROVAL_INVALID'); // not the requester
    await pool.query(`UPDATE approval_requests SET expires_at = now() - interval '1 hour' WHERE id = $1`, [req.body.id]);
    expect((await as('sunita').post(`/jobs/${id}/actions/job.cancel_filed`, { approval_id: req.body.id })).body.error.code).toBe('APPROVAL_INVALID');
    expect((await getJob(id)).stage).toBe('filed');
  });

  it('an ordinary cancel (not yet filed) needs a Supervisor and a reason', async () => {
    const id = await mkJob({ steps: [['job.prepare', 'asha', 5]] });
    const none = await as('dev').post(`/jobs/${id}/actions/job.cancel`);
    expect(none.status).toBe(400);
    expect((await as('neha').post(`/jobs/${id}/actions/job.cancel`, { reason: 'not mine to cancel' })).status).toBe(403);
    const ok = await as('dev').post(`/jobs/${id}/actions/job.cancel`, { reason: 'Client request' });
    expect(ok.status).toBe(200);
    expect(ok.body.stage).toBe('cancelled');
  });

  it('a filed job cannot be changed by the ordinary actions', async () => {
    const id = await mkJob({ steps: FILED });
    for (const [who, action] of [['asha', 'job.prepare'], ['ravi', 'job.check'], ['neha', 'job.file'], ['dev', 'job.cancel']]) {
      const r = await as(who).post(`/jobs/${id}/actions/${action}`, { reason: 'try' });
      expect(r.status).toBe(403);
    }
    expect((await getJob(id)).stage).toBe('filed');
  });
});
