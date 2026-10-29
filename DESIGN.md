# Design: Access Control Service

## 1. The idea in one sentence

> A person **may perform action A on job J at time T** if and only if: they are active, **and** one of their grants (their own, or one they are covering through an absence) gives a role that contains A, **and** that grant's scope covers J's client, branch, direction and mode, **and** J's stage allows A, **and** no separation-of-duties rule blocks it. If anything is unclear, the answer is **no**.

Everything below follows from three principles:

1. **One decision engine.** `can()`, the action buttons, the worklist, the job list, the unattended list and the "who could act on the 3rd" report are all built from the **same SQL fragments** (`backend/src/engine/sql.js`). There is no second copy of the rules to drift (Q13).
2. **Nothing that matters is deleted or overwritten.** Grants, absences and role-permissions carry `valid_from`/`valid_to`; ending a grant sets `valid_to`. History is therefore answerable at any past time (Q11), and the database enforces it with triggers.
3. **Rules are data, not code.** Roles, permissions, workflow transitions, separation-of-duties rules and who-may-grant-what are table rows (Q12).

## 2. Model

| Table | Purpose |
|---|---|
| `users` (`staff` / `client` / `system`) | People, client-side users, the parser. `disabled_at` disables everything at once. |
| `permissions`, `roles`, `role_permissions` | Roles are bundles of permissions. `role_permissions` is time-versioned. `delegable`, `actor_types`, `is_system` flags. |
| **`grants`** | **role + scope (client, branch, direction, mode; NULL = all) + `valid_from`/`valid_to` + reason + `granted_by`.** The heart of the model. |
| `absences` | Absent person, optional delegate, window. Suspends the person's own access and lends delegable roles to the delegate. |
| `jobs` | Client, branch, direction, mode (immutable), stage, owner, prepared/checked/filed by. |
| `job_transitions`, `action_stages`, `sod_rules` | The workflow and separation-of-duties rules as data. |
| `approval_requests` | Two-person rule for cancelling a filed job and for reopening. |
| `role_grant_rights`, `role_conflicts` | Who may hand out which role; which roles one person may not combine. |
| `audit_log` | Append-only. Every job event stores the full "after" state, which is what lets us reconstruct the past. |

**Roles (8):** Maker, Checker, Filer, Supervisor, Controller, Access Admin, Client Viewer, System (Parser).
**Permissions (20):** see (`job.view`, `job.view_internal`, `job.view_history`), work (`create`, `update`, `prepare`, `check`, `file`), dangerous (`cancel`, `cancel_filed`, `reopen`, `reassign`, `admin_fix`, `approve_dangerous`), access (`access.view/grant/revoke`, `absence.manage`, `role.manage`), `audit.read`.

**Database-level safety nets** (they hold even if the application code has a bug): no self-grant (`CHECK granted_by <> user_id`), no self-approval (`CHECK decided_by <> requested_by`), one pending approval per job+action (unique partial index), `audit_log` append-only (trigger), grants never deleted / rewritten / extended / ended retroactively (trigger), a job's scope can never change (trigger).

## 3. How a decision is made

`evaluate()` runs one query that returns every (grant, permission) pair the person effectively holds *right now*, then marks each with `scope_ok`, `stage_ok`, `sod_ok`. `decide()` turns that into an ordered explanation:

`user_active → grant_found → scope_match → stage_allows → separation_of_duties`

The first failing check gives the **reason code** (`USER_DISABLED`, `USER_ABSENT`, `NO_PERMISSION`, `GRANT_NOT_ACTIVE`, `OUT_OF_SCOPE`, `STAGE_NOT_ALLOWED`, `SOD_VIOLATION`, ...); the rest show "not evaluated". When allowed, the explanation names the grant that decided it. **Every write** locks the job row, re-runs `decide()` in the same transaction, changes the job and writes the audit row in that same transaction. Denied attempts are also audited (written after the rollback so they are never lost).

## 4. Key decisions and trade-offs

| Decision | Why | Cost / alternative |
|---|---|---|
| **PostgreSQL, raw SQL, no ORM** | The core is a join between jobs and scoped grants; Postgres gives constraints, triggers, partial indexes and `generate_series`. The SQL *is* the thing to defend. | More SQL to write than with an ORM. |
| **No permission cache** | A cache can be stale after a revoke, which violates "changes take effect when people expect". Measured queries are single-digit ms, so a cache is not needed. | Slightly more database work per request. |
| **Grants carry scope with NULL = all** | One row expresses "Maker for everything" and "Checker for Acme + Mumbai + imports" alike. | Combinations are separate grants (Asha has 3). Simple to read. |
| **Worklist is eligibility-based, owner is only an assignment** | `can()` and the worklist must agree (Q13). Ability never depends on an owner field. | A broad Maker sees *all* confirmed jobs; `?assigned=me` narrows it. |
| **Per-scope index walk for the job list** | First version joined every job and took 430-1,200 ms at 200k jobs. Walking jobs in id order per grant-scope and stopping at one page brought it to under 5 ms. Found by measuring, not guessing. | Slightly unusual SQL (lateral join); it is commented in `sql.js`. |
| **Point-in-time by *replaying the same engine*** | `who-could-act` reconstructs the job as it was (from audit "after" snapshots) and calls the same `evaluate()` for each candidate. | O(candidates) queries (about 500 users = a few seconds). Worth it: no second implementation. |
| **404 instead of 403 when you cannot see a job** | Do not leak that a job exists. | Slightly less helpful message; admins can ask via `/can?user=`. |
| **Identity simulated by a header** | Authentication is not the assessed part. | One function (`authenticate`) to replace. |

## 5. Answers to the 14 questions

**1. Should everyone see everything?** No. *See* and *act* are separate permissions (`job.view`, `job.view_internal`, `job.view_history` vs the work permissions), and both are scoped by grants. A person only sees jobs inside the scopes of their grants. Without `job.view_internal`, the notes, customs reference and all staff names are removed. A client user gets `job.view` only. Visibility is computed in the same query as ability, per row.

**2. Maker everywhere but Checker for a few clients; Checker for one client + one branch + imports.** A grant is *(role, client, branch, direction, mode)* with NULL meaning "all". Asha = one all-NULL Maker grant plus one Checker grant each for Acme and Bolt. Ravi = one Checker grant with client=Acme, branch=Mumbai, direction=import, mode=NULL. The access endpoint prints it as "Ravi Menon has role Checker for client Acme, branch Mumbai, direction import, all modes."

**3. The preparer is also qualified to approve.** `sod_rules`: the person recorded as `prepared_by` cannot `job.check` the same job; `checked_by` cannot `job.file`. They keep the role; they are only blocked on that job, and the denial says exactly which rule and why (`SOD_VIOLATION`). A delegate cannot launder a conflict: the rule also blocks the person being covered.

**4. The person responsible is absent.** An `absences` row suspends the absent person's own access for the window and gives the named delegate the absent person's *delegable* roles (Maker/Checker/Filer), still bound by separation of duties. The audit trail records "on behalf of". If nobody covers, a job that was assigned to them appears in the **unattended** list for people who may reassign (`/me/unattended`). Reassignment requires the new assignee to be able to do the next step.

**5. Responsibilities change mid-job.** Ability follows grants, never the owner field, so the change applies on the very next request. The job **keeps its stage**; the old owner can no longer act and appears as `OWNER_LOST_AUTHORITY` in the unattended list; whoever holds the grant now sees it in their worklist.

**6. Cancel a filed job / reopen a closed one.** Only Controllers hold `job.cancel_filed` / `job.reopen`. It takes (a) a mandatory reason, (b) an approval request, (c) approval by a **different** Controller (`SELF_APPROVAL` otherwise; the database also checks), (d) execution by the requester with the approval id. Approvals expire after 24 h and are single use. Every step is audited. A Supervisor or Filer is refused outright.

**7. A client's own employee follows their shipments.** Role *Client Viewer*: `job.view` only, grant locked to their own client (the API refuses any other client, and refuses staff roles for client users). They see no internal fields, no history, no worklist, and cannot act.

**8. Admin fixes a stuck job / tries to become more powerful.** Fixing: `job.admin_fix` can send a job *back* to an earlier stage with a mandatory reason, never forward (so it cannot skip the checker), never when filed or cancelled, always audited as an override. Escalating: nobody can grant to themselves (code **and** a database CHECK); an Access Admin can only hand out roles listed in `role_grant_rights` (not Controller or Access Admin), only inside their own scope (no widening), not to a user type that cannot hold the role, and not roles that conflict with what the person holds (Access Admin + Maker). They cannot end their own grant. Each refusal is audited.

**9. The overnight parser.** A `system` user with the *System (Parser)* role: `job.create`, `job.update` (only while confirmed/reopened), `job.view`. It cannot prepare, check, file, cancel, reopen, reassign or approve, and the API refuses to give it any human role (`actor_types`). Its actions are audited under its own name.

**10. "Why can she do this and he can't?"** `GET /explain/compare` runs the engine for both people and returns both explanations plus the first check where they differ, in a sentence. The UI shows the two checklists side by side.

**11. "Who could have changed this job on the 3rd?"** `GET /jobs/:id/who-could-act?at=...`. The job's state then (stage, preparer, checker) is rebuilt from the audit "after" snapshots; its scope is immutable; the same engine is evaluated at that time with the grants, role definitions and absences that were valid then. Demo: job 7 - Tina could check it 15 days ago, not today. If the job did not exist, or its history is missing, the answer is "nobody" with the reason (fail closed).

**12. A new kind of role next quarter, without engineering.** `POST /roles` with a name and permissions; grant it like any role; edit with `PUT /roles/:id/permissions`. It is scoped like every role. Changes are versioned. Guardrails: dangerous permissions can never be put in a role through the API, built-in roles are locked, and only `role.manage` holders can do this. (A new *workflow stage or action* would still be a data change in `job_transitions` plus a permission row; no engine change.)

**13. "Jobs waiting for me" matches what I can do.** Same SQL fragments for both, and a test (`worklist-consistency`) compares the list, the count, and `can()` for every work-stage job, for 13 different people.

**14. When the system is unsure.** It denies. Unknown action, missing job or stage, unknown or disabled user, or any internal error becomes `allowed: false` with reason `FAIL_CLOSED` / `UNKNOWN_ACTION` / `MISSING_INPUT`, and the attempt is logged. Missing history for a point-in-time question reports "nobody".

## 6. Questions we added

**A. What happens when someone leaves?** `POST /users/:id/disable` ends every active and future grant and disables the account in one transaction; all their decisions fail with `USER_DISABLED`; their assigned jobs show up as unattended.

**B. Can one person be both Admin and Maker/Checker/Filer?** No (`role_conflicts`). The person who manages access cannot also do the work that access protects.

**C. Who approves the approver?** Controllers and Access Admins can only be created by the bootstrap CLI, outside the API; nobody can hand them out. A Controller's dangerous action needs a second Controller.

**D. Can history be rewritten?** Not through the application, and not casually in the database: audit rows cannot be updated or deleted, grants cannot be deleted, rewritten, extended or ended retroactively, and API grants and absences cannot be back-dated. (A database superuser can still bypass triggers; in production we would also revoke those privileges and chain-hash the audit log.)

**E. Whose clock?** The database's (`now()`, `timestamptz`, UTC) for every decision, so application servers with drifting clocks cannot disagree.

## 7. Scale and timing

* **Scale (500 users, 200,000 jobs):** list pages are 0.3-0.7 ms of database time; a worklist *count* is about 45 ms for broad users. Results and method are in the README; reproduce with `npm run seed:scale`. Indexes: `jobs(stage, client, branch, direction, mode)`, partial `jobs(owner_id)`, `grants(user_id, valid_from, valid_to)`.
* **Timing:** there is no cache. A grant, revoke, absence or role change is visible on the very next request. A future-dated grant starts at its start time. An ended grant stops at the moment it was ended.

## 8. Known limitations

* `who-could-act` evaluates each candidate separately (fine at 500 users; a set-based version would be the next step).
* Jobs nobody at all can act on ("orphans") are not listed proactively; they are found with `who-could-act`.
* Authentication, user management and a polished UI are out of scope (see README, "What was cut").
