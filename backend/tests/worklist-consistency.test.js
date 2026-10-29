// Q13: the "jobs waiting for me" list and count must match exactly what can() allows.
import { describe, it, expect } from 'vitest';
import { as, uid, pool } from './helpers/client.js';
import { decide } from '../src/engine/decision.js';

const NEXT = { confirmed: 'job.prepare', reopened: 'job.prepare', prepared: 'job.check', checked: 'job.file' };

async function fullWorklist(key) {
  const ids = []; let cursor = 0;
  for (;;) {
    const r = await as(key).get(`/me/worklist?limit=200&cursor=${cursor}`);
    ids.push(...r.body.items.map((j) => j.id));
    if (!r.body.next_cursor) break;
    cursor = r.body.next_cursor;
  }
  return ids;
}

describe('Q13 worklist == can()', () => {
  it('for every kind of person, list = count = exactly the jobs where can() is true', async () => {
    const jobs = (await pool.query(`SELECT * FROM jobs WHERE stage IN ('confirmed','prepared','checked','reopened') ORDER BY id`)).rows;
    expect(jobs.length).toBeGreaterThan(50);
    const people = ['asha', 'ravi', 'meera', 'karan', 'neha', 'imran', 'tina', 'lata', 'anita', 'farhan', 'pooja', 'zoya', 'parser'];
    let totalListed = 0;
    for (const key of people) {
      const userId = await uid(key);
      const listed = new Set(await fullWorklist(key));
      const count = (await as(key).get('/me/worklist/count')).body.count;
      expect(count, `${key} count`).toBe(listed.size);
      totalListed += listed.size;
      for (let i = 0; i < jobs.length; i += 25) {
        const chunk = jobs.slice(i, i + 25);
        const verdicts = await Promise.all(chunk.map((j) => decide(pool, { userId, action: NEXT[j.stage], job: j })));
        chunk.forEach((j, k) => expect(verdicts[k].allowed, `${key} job ${j.job_no} (${j.stage})`).toBe(listed.has(j.id)));
      }
    }
    expect(totalListed).toBeGreaterThan(0);
  });
  it('the worklist reacts to people: absent Meera has none, her delegate Karan sees Delhi jobs', async () => {
    expect((await as('meera').get('/me/worklist/count')).body.count).toBe(0);
    const karan = (await as('karan').get('/me/worklist?limit=200')).body.items;
    expect(karan.some((j) => j.branch_name === 'Delhi' && j.via_delegation)).toBe(true);
    expect(karan.some((j) => j.branch_name === 'Chennai' && !j.via_delegation)).toBe(true);
  });
  it('"assigned to me" filters the list', async () => {
    const mine = (await as('karan').get('/me/worklist?assigned=me&limit=200')).body.items;
    expect(mine.every((j) => j.mine)).toBe(true);
  });
});
