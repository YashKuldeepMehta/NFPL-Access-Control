import { describe, it, expect, vi } from 'vitest';
import { as, anon, mkJob, newUser, grant, uid, pool, getJob } from './helpers/client.js';
import { decide } from '../src/engine/decision.js';

describe('Q14 when the system is unsure, it denies', () => {
  it('unknown action, missing input, broken database: all DENY with a reason', async () => {
    const job = await getJob(await mkJob());
    const userId = await uid('asha');
    expect((await decide(pool, { userId, action: 'job.teleport', job })).reason_code).toBe('UNKNOWN_ACTION');
    expect((await decide(pool, { userId, action: 'job.prepare', job: null })).reason_code).toBe('MISSING_INPUT');
    expect((await decide(pool, { userId, action: 'job.prepare', job: { ...job, stage: null } })).reason_code).toBe('MISSING_INPUT');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { query: async () => { throw new Error('database exploded'); } };
    const r = await decide(broken, { userId, action: 'job.prepare', job });
    spy.mockRestore();
    expect(r.allowed).toBe(false);
    expect(r.reason_code).toBe('FAIL_CLOSED');
  });
  it('over HTTP: unknown action is a clean denial, unknown job is a 404, bad input is a 400', async () => {
    const id = await mkJob();
    const r = await as('asha').get(`/can?action=job.teleport&job=${id}`);
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false);
    expect((await as('asha').get('/can?action=job.prepare&job=99999999')).status).toBe(404);
    expect((await as('asha').get('/can?action=job.prepare')).status).toBe(400);
    expect((await as('asha').post(`/jobs/${id}/actions/job.teleport`)).status).toBe(400);
  });
  it('a disabled user is denied everything', async () => {
    const u = await newUser();
    await grant(u.id, 'maker');
    await pool.query(`UPDATE users SET status='disabled', disabled_at = now() WHERE id=$1`, [u.id]);
    const id = await mkJob();
    const r = await decide(pool, { userId: u.id, action: 'job.prepare', job: await getJob(id) });
    expect(r.reason_code).toBe('USER_DISABLED');
    expect((await as(u.key).get('/me')).status).toBe(403);
  });
});

describe('the database guards the history', () => {
  it('audit_log is append-only', async () => {
    await expect(pool.query(`UPDATE audit_log SET event = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
  });
  it('grants are never deleted, rewritten, extended or ended retroactively', async () => {
    const u = await newUser();
    const gid = await grant(u.id, 'maker');
    await expect(pool.query('DELETE FROM grants WHERE id = $1', [gid])).rejects.toThrow(/never deleted/);
    await expect(pool.query(`UPDATE grants SET valid_from = valid_from - interval '30 days' WHERE id = $1`, [gid])).rejects.toThrow(/never rewritten/);
    await expect(pool.query(`UPDATE grants SET valid_to = now() - interval '5 days' WHERE id = $1`, [gid])).rejects.toThrow(/retroactively/);
    await pool.query(`UPDATE grants SET valid_to = now() WHERE id = $1`, [gid]);          // ending it NOW is fine
    await expect(pool.query(`UPDATE grants SET valid_to = now() + interval '5 days' WHERE id = $1`, [gid])).rejects.toThrow(/extended/);
  });
  it('a job\'s scope can never change (point-in-time answers depend on it)', async () => {
    const id = await mkJob();
    await expect(pool.query(`UPDATE jobs SET branch_id = branch_id + 1 WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
  });
  it('every change writes its audit row in the same transaction', async () => {
    const id = await mkJob({ steps: [['job.prepare', 'asha', 5]] });
    const before = (await pool.query('SELECT count(*)::int n FROM audit_log WHERE job_id=$1', [id])).rows[0].n;
    await as('ravi').post(`/jobs/${id}/actions/job.check`);
    const rows = (await pool.query(`SELECT event, actor_id, detail FROM audit_log WHERE job_id=$1 ORDER BY id DESC LIMIT 1`, [id])).rows[0];
    expect(rows.event).toBe('job.transition');
    expect(rows.actor_id).toBe(await uid('ravi'));
    expect(rows.detail.after.stage).toBe('checked');
    expect((await pool.query('SELECT count(*)::int n FROM audit_log WHERE job_id=$1', [id])).rows[0].n).toBe(before + 1);
  });
});
