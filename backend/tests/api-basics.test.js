import { describe, it, expect } from 'vitest';
import { anon, as } from './helpers/client.js';

describe('API basics', () => {
  it('health works without identity', async () => {
    const r = await anon().get('/health');
    expect(r.body.ok).toBe(true);
  });
  it('401 without an identity, and for an unknown user', async () => {
    expect((await anon().get('/me')).status).toBe(401);
    expect((await as('nobody-here').get('/me')).status).toBe(401);
  });
  it('GET /me describes my access in plain language', async () => {
    const r = await as('ravi').get('/me');
    expect(r.body.access).toContain('Ravi Menon has role Checker for client Acme, branch Mumbai, direction import, all modes.');
  });
});
