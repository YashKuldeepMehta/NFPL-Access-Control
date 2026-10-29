// =====================================================================
// The shared SQL fragments behind EVERY access decision.
//
// can(), "what can I do on this job", the worklist, the visible-jobs list and the
// unattended list are all built from the SAME fragments below. That is how the
// "jobs waiting for me" count can never disagree with what can() allows (Q13).
//
// Parameters used by every query that includes the CTEs:
//   $1 = user id          $2 = evaluation time (NULL means "now", taken from the DATABASE clock)
// =====================================================================

// The evaluation time. Always the database clock unless a past time is given.
export const AT = 'COALESCE($2::timestamptz, now())';

// Whose grants may this user use right now?
//  - their own, unless they are absent (own access is suspended during an absence)
//  - the grants of anyone they are covering for (absence delegation)
//  - nothing at all if the user is disabled, or is absent themselves
export const PRINCIPALS_CTE = `
principals AS (
  SELECT x.via_user, x.absence_id
  FROM (
    SELECT $1::int AS via_user, NULL::int AS absence_id
    UNION ALL
    SELECT a.user_id, a.id
    FROM absences a
    WHERE a.delegate_id = $1::int AND ${AT} >= a.valid_from AND ${AT} < a.valid_to
  ) x
  WHERE EXISTS (SELECT 1 FROM users u
                WHERE u.id = $1::int AND (u.disabled_at IS NULL OR ${AT} < u.disabled_at))
    AND NOT EXISTS (SELECT 1 FROM absences a2
                    WHERE a2.user_id = $1::int AND ${AT} >= a2.valid_from AND ${AT} < a2.valid_to)
)`;

// Effective (grant, permission) pairs valid at the evaluation time.
// A delegate only inherits roles flagged delegable.
export const EFF_CTE = `
eff AS (
  SELECT g.id AS grant_id, g.client_id, g.branch_id, g.direction, g.mode,
         r.code AS role_code, r.name AS role_name, rp.permission_code,
         p.via_user, p.absence_id
  FROM principals p
  JOIN grants g ON g.user_id = p.via_user
               AND ${AT} >= g.valid_from AND (g.valid_to IS NULL OR ${AT} < g.valid_to)
  JOIN roles r ON r.id = g.role_id
               AND (r.retired_at IS NULL OR ${AT} < r.retired_at)
               AND (p.absence_id IS NULL OR r.delegable)
  JOIN role_permissions rp ON rp.role_id = g.role_id
               AND ${AT} >= rp.valid_from AND (rp.valid_to IS NULL OR ${AT} < rp.valid_to)
)`;

// NULL on a grant dimension means "all". `e` = grant-like row, `j` = job-like row.
export const scopeMatch = (e = 'e', j = 'j') => `(
  (${e}.client_id IS NULL OR ${e}.client_id = ${j}.client_id) AND
  (${e}.branch_id IS NULL OR ${e}.branch_id = ${j}.branch_id) AND
  (${e}.direction IS NULL OR ${e}.direction = ${j}.direction) AND
  (${e}.mode      IS NULL OR ${e}.mode      = ${j}.mode))`;

// Separation of duties: blocked when the person recorded in the rule's column is the
// caller OR the person the caller is covering for (a delegate cannot launder a conflict).
export const sodOk = (action, e = 'e', j = 'j') => `NOT EXISTS (
  SELECT 1 FROM sod_rules s
  WHERE s.action = ${action}
    AND (CASE s.actor_column WHEN 'prepared_by' THEN ${j}.prepared_by
                             WHEN 'checked_by'  THEN ${j}.checked_by END) IN ($1::int, ${e}.via_user))`;

// ---------------------------------------------------------------------
// 1. Single-job evaluation. The job is passed as a SNAPSHOT so the very same SQL can be
//    used for today's job and for a reconstructed past state (Q11).
//    $3 action (NULL = every permission), $4 client, $5 branch, $6 direction, $7 mode,
//    $8 stage (NULL only for job.create), $9 prepared_by, $10 checked_by
//    Always returns at least one row (meta), then one row per effective (grant, permission).
// ---------------------------------------------------------------------
export const EVALUATE_SQL = `
WITH ${PRINCIPALS_CTE},
${EFF_CTE},
j AS (
  SELECT $4::int AS client_id, $5::int AS branch_id, $6::text AS direction, $7::text AS mode,
         $8::text AS stage, $9::int AS prepared_by, $10::int AS checked_by
),
meta AS (
  SELECT
    (SELECT count(*)::int FROM users WHERE id = $1::int) AS user_found,
    (SELECT (disabled_at IS NULL OR ${AT} < disabled_at) FROM users WHERE id = $1::int) AS user_active,
    (SELECT name FROM users WHERE id = $1::int) AS user_name,
    EXISTS (SELECT 1 FROM absences a WHERE a.user_id = $1::int AND ${AT} >= a.valid_from AND ${AT} < a.valid_to) AS absent_now,
    (SELECT a.delegate_id FROM absences a WHERE a.user_id = $1::int AND ${AT} >= a.valid_from AND ${AT} < a.valid_to
       ORDER BY a.id DESC LIMIT 1) AS absence_delegate_id,
    ($3::text IS NULL OR EXISTS (SELECT 1 FROM permissions WHERE code = $3::text)) AS perm_exists,
    ${AT} AS evaluated_at
)
SELECT m.*, c.grant_id, c.role_code, c.role_name, c.permission_code, c.via_user, c.via_name, c.absence_id,
       c.scope_ok, c.stage_ok, c.sod_ok, c.to_stage, c.requires_reason, c.requires_approval,
       c.client_id AS g_client_id, c.branch_id AS g_branch_id, c.direction AS g_direction, c.mode AS g_mode
FROM meta m
LEFT JOIN LATERAL (
  SELECT e.grant_id, e.role_code, e.role_name, e.permission_code, e.via_user, e.absence_id,
         e.client_id, e.branch_id, e.direction, e.mode,
         (SELECT u.name FROM users u WHERE u.id = e.via_user) AS via_name,
         ${scopeMatch('e', 'j')} AS scope_ok,
         (j.stage IS NULL OR EXISTS (SELECT 1 FROM action_stage_allowed s
                                     WHERE s.action = e.permission_code AND s.stage = j.stage)) AS stage_ok,
         ${sodOk('e.permission_code', 'e', 'j')} AS sod_ok,
         t.to_stage, t.requires_reason, t.requires_approval
  FROM eff e
  CROSS JOIN j
  LEFT JOIN job_transitions t ON t.action = e.permission_code AND t.from_stage = j.stage
  WHERE ($3::text IS NULL OR e.permission_code = $3::text)
) c ON true
ORDER BY c.absence_id NULLS FIRST, c.grant_id`;

// Why does a user hold no usable grant for a permission? (only run on the denial path)
export const DIAGNOSE_GRANT_SQL = `
SELECT g.id AS grant_id, r.name AS role_name, g.valid_from, g.valid_to
FROM grants g
JOIN roles r ON r.id = g.role_id
JOIN role_permissions rp ON rp.role_id = g.role_id AND rp.permission_code = $2
WHERE g.user_id = $1
ORDER BY g.valid_from DESC
LIMIT 5`;

// ---------------------------------------------------------------------
// 2. Worklist: jobs this person can act on RIGHT NOW with a routine (in_worklist) action.
//    $3 assigned filter ('any' | 'me' | 'unassigned'), $4 cursor (job id), $5 limit
// ---------------------------------------------------------------------
const WORKLIST_FROM = `
FROM jobs j
JOIN job_transitions t ON t.from_stage = j.stage AND t.in_worklist
JOIN eff e ON e.permission_code = t.action AND ${scopeMatch('e', 'j')}
WHERE ${sodOk('t.action', 'e', 'j')}
  AND ($3::text = 'any'
       OR ($3::text = 'me' AND j.owner_id = e.via_user)
       OR ($3::text = 'unassigned' AND j.owner_id IS NULL))`;

export const WORKLIST_PAGE_SQL = `
WITH ${PRINCIPALS_CTE}, ${EFF_CTE},
page AS (
  SELECT DISTINCT ON (j.id)
         j.id, j.job_no, j.client_id, j.branch_id, j.direction, j.mode, j.stage, j.owner_id, j.updated_at,
         t.action AS next_action, e.grant_id, e.role_name, e.via_user, (e.absence_id IS NOT NULL) AS via_delegation,
         (j.owner_id = e.via_user) AS mine
  ${WORKLIST_FROM}
    AND j.id > $4::int
  ORDER BY j.id, (e.absence_id IS NOT NULL), e.grant_id
  LIMIT $5::int
)
SELECT p.*, c.name AS client_name, b.name AS branch_name
FROM page p
JOIN clients c ON c.id = p.client_id
JOIN branches b ON b.id = p.branch_id
ORDER BY p.id`;

export const WORKLIST_COUNT_SQL = `
WITH ${PRINCIPALS_CTE}, ${EFF_CTE}
SELECT count(DISTINCT j.id)::int AS n
${WORKLIST_FROM}`;

// ---------------------------------------------------------------------
// 3. Jobs this person may SEE (job.view). $3 cursor, $4 limit, $5 stage, $6 client, $7 branch
//    can_view_internal decides, per row, whether internal fields are redacted.
// ---------------------------------------------------------------------
export const VISIBLE_JOBS_SQL = `
WITH ${PRINCIPALS_CTE}, ${EFF_CTE},
scopes AS (   -- a person has only a handful of distinct view-scopes
  SELECT DISTINCT client_id, branch_id, direction, mode FROM eff WHERE permission_code = 'job.view'
),
ids AS (      -- per scope: walk jobs in id order and STOP after one page; then merge the (few) candidates
  SELECT DISTINCT x.id
  FROM scopes s
  CROSS JOIN LATERAL (
    SELECT j.id FROM jobs j
     WHERE j.id > $3::int AND ${scopeMatch('s', 'j')}
       AND ($5::text IS NULL OR j.stage = $5::text)
       AND ($6::int  IS NULL OR j.client_id = $6::int)
       AND ($7::int  IS NULL OR j.branch_id = $7::int)
     ORDER BY j.id
     LIMIT $4::int
  ) x
  ORDER BY x.id
  LIMIT $4::int
),
page AS (
  SELECT j.*,
         EXISTS (SELECT 1 FROM eff e2 WHERE e2.permission_code = 'job.view_internal'
                 AND ${scopeMatch('e2', 'j')}) AS can_view_internal
  FROM jobs j JOIN ids ON ids.id = j.id
)
SELECT p.*, c.name AS client_name, b.name AS branch_name
FROM page p
JOIN clients c ON c.id = p.client_id
JOIN branches b ON b.id = p.branch_id
ORDER BY p.id`;

// ---------------------------------------------------------------------
// 4. Unattended jobs: an owner is assigned but that person can no longer do the next step
//    (disabled, absent with nobody covering, or their grant ended). Only shown to people who
//    may reassign. $3 cursor, $4 limit
// ---------------------------------------------------------------------
export const UNATTENDED_SQL = `
WITH ${PRINCIPALS_CTE}, ${EFF_CTE}
SELECT DISTINCT ON (j.id)
       j.id, j.job_no, j.client_id, j.branch_id, j.direction, j.mode, j.stage, j.owner_id,
       o.name AS owner_name, t.action AS next_action,
       CASE
         WHEN o.disabled_at IS NOT NULL THEN 'OWNER_DISABLED'
         WHEN EXISTS (SELECT 1 FROM absences a WHERE a.user_id = o.id AND ${AT} >= a.valid_from
                      AND ${AT} < a.valid_to AND a.delegate_id IS NULL) THEN 'OWNER_ABSENT_NO_DELEGATE'
         ELSE 'OWNER_LOST_AUTHORITY'
       END AS unattended_reason
FROM jobs j
JOIN users o ON o.id = j.owner_id
JOIN job_transitions t ON t.from_stage = j.stage AND t.in_worklist
JOIN eff e ON e.permission_code = 'job.reassign' AND ${scopeMatch('e', 'j')}
WHERE j.id > $3::int
  AND j.owner_id IS NOT NULL     -- lets the planner use the partial index jobs_owner_idx
  AND (
    o.disabled_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM absences a WHERE a.user_id = o.id AND ${AT} >= a.valid_from
               AND ${AT} < a.valid_to AND a.delegate_id IS NULL)
    OR NOT EXISTS (
      SELECT 1 FROM grants g
      JOIN role_permissions rp ON rp.role_id = g.role_id AND rp.permission_code = t.action
                              AND ${AT} >= rp.valid_from AND (rp.valid_to IS NULL OR ${AT} < rp.valid_to)
      WHERE g.user_id = o.id AND ${AT} >= g.valid_from AND (g.valid_to IS NULL OR ${AT} < g.valid_to)
        AND ${scopeMatch('g', 'j')})
  )
ORDER BY j.id
LIMIT $4::int`;

// ---------------------------------------------------------------------
// 5. Approvals this person could decide (job.approve_dangerous in scope, not their own request)
// ---------------------------------------------------------------------
export const PENDING_APPROVALS_SQL = `
WITH ${PRINCIPALS_CTE}, ${EFF_CTE}
SELECT DISTINCT ON (ar.id) ar.id, ar.job_id, j.job_no, ar.action, ar.requested_by, ru.name AS requested_by_name,
       ar.reason, ar.status, ar.created_at, ar.expires_at, j.stage
FROM approval_requests ar
JOIN jobs j ON j.id = ar.job_id
JOIN users ru ON ru.id = ar.requested_by
JOIN eff e ON e.permission_code = 'job.approve_dangerous' AND ${scopeMatch('e', 'j')}
WHERE ar.status = 'pending' AND ar.expires_at > ${AT} AND ar.requested_by <> $1::int
ORDER BY ar.id`;
