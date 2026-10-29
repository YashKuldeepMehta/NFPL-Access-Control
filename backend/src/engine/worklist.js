import {
  WORKLIST_PAGE_SQL, WORKLIST_COUNT_SQL, VISIBLE_JOBS_SQL, UNATTENDED_SQL, PENDING_APPROVALS_SQL,
} from './sql.js';

export async function worklistPage(db, userId, { assigned = 'any', cursor = 0, limit = 50, at = null } = {}) {
  const { rows } = await db.query(WORKLIST_PAGE_SQL, [userId, at, assigned, cursor, limit]);
  return { items: rows, next_cursor: rows.length === limit ? rows[rows.length - 1].id : null };
}

export async function worklistCount(db, userId, { assigned = 'any', at = null } = {}) {
  const { rows } = await db.query(WORKLIST_COUNT_SQL, [userId, at, assigned]);
  return rows[0].n;
}

export async function visibleJobsPage(db, userId, { cursor = 0, limit = 50, stage = null, clientId = null, branchId = null, at = null } = {}) {
  const { rows } = await db.query(VISIBLE_JOBS_SQL, [userId, at, cursor, limit, stage, clientId, branchId]);
  return { items: rows, next_cursor: rows.length === limit ? rows[rows.length - 1].id : null };
}

export async function unattendedPage(db, userId, { cursor = 0, limit = 50, at = null } = {}) {
  const { rows } = await db.query(UNATTENDED_SQL, [userId, at, cursor, limit]);
  return { items: rows, next_cursor: rows.length === limit ? rows[rows.length - 1].id : null };
}

export async function pendingApprovals(db, userId) {
  const { rows } = await db.query(PENDING_APPROVALS_SQL, [userId, null]);
  return rows;
}
