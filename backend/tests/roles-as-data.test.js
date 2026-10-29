// Q12: a new kind of role next quarter, with no engineering.
import { describe, it, expect } from 'vitest';
import { as, mkJob, newUser, branchId, pool } from './helpers/client.js';

describe('Q12 roles are data', () => {
  it('create a role, grant it, and it works at once; edit it and the change applies at once', async () => {
    const code = `customs_clerk_${Date.now().toString(36)}`;
    const created = await as('vikram').post('/roles', { code, name: 'Customs Clerk', actor_types: ['staff'], permissions: ['job.view', 'job.view_internal', 'job.prepare'] });
    expect(created.status).toBe(201);
    const u = await newUser();
    const g = await as('vikram').post('/grants', { user_id: u.id, role_code: code, branch_id: await branchId('KOL'), reason: 'New Kolkata clerk' });
    expect(g.status).toBe(201);
    const kol = await mkJob({ branch: 'KOL', client: 'FALCON' });
    const mum = await mkJob({ branch: 'MUM', client: 'FALCON' });
    expect((await as(u.key).get(`/can?action=job.prepare&job=${kol}`)).body.allowed).toBe(true);          // scoped like any role
    expect((await as(u.key).get(`/jobs/${mum}`)).status).toBe(404);                                       // other branch: invisible
    const edit = await as('vikram').put(`/roles/${created.body.id}/permissions`, { permissions: ['job.view', 'job.view_internal'], reason: 'Clerks only look for now' });
    expect(edit.body.removed).toEqual(['job.prepare']);
    expect((await as(u.key).get(`/can?action=job.prepare&job=${kol}`)).body.allowed).toBe(false);         // immediate
    // role-permissions are time-versioned: the old definition is still in the table for history
    const hist = await pool.query(`SELECT valid_to FROM role_permissions WHERE role_id=$1 AND permission_code='job.prepare'`, [created.body.id]);
    expect(hist.rows[0].valid_to).not.toBeNull();
  });
  it('guardrails: no dangerous permission in a new role, built-in roles are locked, unknown permissions refused', async () => {
    const bad = await as('vikram').post('/roles', { code: 'sneaky_role', name: 'Sneaky', permissions: ['job.view', 'job.cancel_filed'] });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('DANGEROUS_PERMISSION');
    const roles = (await as('vikram').get('/roles')).body.items;
    const maker = roles.find((r) => r.code === 'maker');
    const lock = await as('vikram').put(`/roles/${maker.id}/permissions`, { permissions: ['job.view'], reason: 'try it' });
    expect(lock.body.error.code).toBe('SYSTEM_ROLE_LOCKED');
    const unknown = await as('vikram').post('/roles', { code: 'odd_role', name: 'Odd', permissions: ['job.fly'] });
    expect(unknown.status).toBe(400);
  });
  it('only people with role.manage can do this', async () => {
    const r = await as('sunita').post('/roles', { code: 'nope_role', name: 'Nope', permissions: ['job.view'] });
    expect(r.status).toBe(403);
  });
});
