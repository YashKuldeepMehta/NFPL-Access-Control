-- =====================================================================
-- 001_schema.sql : complete schema for the NFPL Access Control Service
-- Design rule: nothing that matters for history is ever deleted.
-- Grants, absences and role-permissions carry valid_from / valid_to so that
-- "who could have changed this job on the 3rd?" can be answered later.
-- =====================================================================

-- ---------- Reference data ----------
CREATE TABLE branches (
  id   serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL
);

CREATE TABLE clients (
  id   serial PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL
);

CREATE TABLE users (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  email       text UNIQUE NOT NULL,
  type        text NOT NULL CHECK (type IN ('staff','client','system')),
  client_id   int REFERENCES clients(id),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CHECK (type <> 'client' OR client_id IS NOT NULL),      -- client users belong to a client
  CHECK (type = 'client' OR client_id IS NULL),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

-- ---------- Roles, permissions: all DATA (Q12: new role without a deploy) ----------
CREATE TABLE permissions (
  code         text PRIMARY KEY,                -- e.g. 'job.check'
  description  text NOT NULL,
  is_dangerous boolean NOT NULL DEFAULT false   -- dangerous permissions can never be put into a role through the API
);

CREATE TABLE roles (
  id          serial PRIMARY KEY,
  code        text UNIQUE NOT NULL,
  name        text NOT NULL,
  actor_types text[] NOT NULL,                  -- who may hold it: {staff} / {client} / {system}
  delegable   boolean NOT NULL DEFAULT false,   -- may a delegate inherit it during an absence?
  is_system   boolean NOT NULL DEFAULT false,   -- built-in roles cannot be edited through the API
  retired_at  timestamptz
);

CREATE TABLE role_permissions (                 -- time-versioned, so history stays true
  role_id         int  NOT NULL REFERENCES roles(id),
  permission_code text NOT NULL REFERENCES permissions(code),
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  changed_by      int REFERENCES users(id),
  PRIMARY KEY (role_id, permission_code, valid_from),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

CREATE TABLE role_grant_rights (                -- which role may hand out which role (anti-escalation)
  granter_role_id   int NOT NULL REFERENCES roles(id),
  grantable_role_id int NOT NULL REFERENCES roles(id),
  PRIMARY KEY (granter_role_id, grantable_role_id)
);

CREATE TABLE role_conflicts (                   -- one person may not hold both at once
  role_a int NOT NULL REFERENCES roles(id),
  role_b int NOT NULL REFERENCES roles(id),
  PRIMARY KEY (role_a, role_b)
);

-- ---------- Access ----------
CREATE TABLE grants (
  id         serial PRIMARY KEY,
  user_id    int NOT NULL REFERENCES users(id),
  role_id    int NOT NULL REFERENCES roles(id),
  client_id  int REFERENCES clients(id),        -- NULL = all clients
  branch_id  int REFERENCES branches(id),       -- NULL = all branches
  direction  text CHECK (direction IN ('import','export')),   -- NULL = both
  mode       text CHECK (mode IN ('air','fcl','lcl')),        -- NULL = all
  valid_from timestamptz NOT NULL DEFAULT now(),               -- future-dated grants allowed
  valid_to   timestamptz,                                      -- revoke = set valid_to. NEVER delete.
  reason     text NOT NULL,
  granted_by int NOT NULL REFERENCES users(id),
  ended_by   int REFERENCES users(id),
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (granted_by <> user_id)                 -- DB-level: nobody grants themselves anything
);
CREATE INDEX grants_user_idx ON grants (user_id, valid_from, valid_to);

CREATE TABLE absences (
  id          serial PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id),   -- the absent person
  delegate_id int REFERENCES users(id),            -- NULL = nobody covering
  valid_from  timestamptz NOT NULL,
  valid_to    timestamptz NOT NULL,
  reason      text NOT NULL,
  created_by  int NOT NULL REFERENCES users(id),
  ended_by    int REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to >= valid_from),
  CHECK (delegate_id IS NULL OR delegate_id <> user_id)
);
CREATE INDEX absences_user_idx     ON absences (user_id, valid_from, valid_to);
CREATE INDEX absences_delegate_idx ON absences (delegate_id, valid_from, valid_to);

-- ---------- Jobs and workflow (the workflow is data too) ----------
CREATE SEQUENCE job_no_seq;

CREATE TABLE jobs (
  id             serial PRIMARY KEY,
  job_no         text UNIQUE NOT NULL,
  client_id      int  NOT NULL REFERENCES clients(id),
  branch_id      int  NOT NULL REFERENCES branches(id),
  direction      text NOT NULL CHECK (direction IN ('import','export')),
  mode           text NOT NULL CHECK (mode IN ('air','fcl','lcl')),
  stage          text NOT NULL CHECK (stage IN ('confirmed','prepared','checked','filed','cancelled','reopened')),
  owner_id       int REFERENCES users(id),   -- who is assigned to do the NEXT step (informational; GRANTS decide ability)
  prepared_by    int REFERENCES users(id),
  checked_by     int REFERENCES users(id),
  filed_by       int REFERENCES users(id),
  internal_notes text,                       -- hidden from client users
  customs_ref    text,                       -- hidden from client users
  created_by     int REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_stage_scope_idx ON jobs (stage, client_id, branch_id, direction, mode);
CREATE INDEX jobs_client_idx      ON jobs (client_id);
CREATE INDEX jobs_owner_idx       ON jobs (owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE job_transitions (               -- actions that MOVE a job between stages
  action            text NOT NULL REFERENCES permissions(code),
  from_stage        text NOT NULL,
  to_stage          text NOT NULL,
  in_worklist       boolean NOT NULL DEFAULT false,   -- is this routine "needs me" work?
  requires_reason   boolean NOT NULL DEFAULT false,
  requires_approval boolean NOT NULL DEFAULT false,   -- two-person rule
  PRIMARY KEY (action, from_stage)
);

CREATE TABLE action_stages (                 -- actions that do NOT move a job, and the stages they are allowed in
  action text NOT NULL REFERENCES permissions(code),
  stage  text NOT NULL,
  PRIMARY KEY (action, stage)
);

CREATE VIEW action_stage_allowed AS
  SELECT action, from_stage AS stage FROM job_transitions
  UNION
  SELECT action, stage FROM action_stages;

CREATE TABLE sod_rules (                     -- separation of duties, as data
  action       text NOT NULL REFERENCES permissions(code),
  actor_column text NOT NULL CHECK (actor_column IN ('prepared_by','checked_by')),
  PRIMARY KEY (action, actor_column)
);

CREATE TABLE approval_requests (             -- two-person rule for dangerous actions
  id            serial PRIMARY KEY,
  job_id        int NOT NULL REFERENCES jobs(id),
  action        text NOT NULL REFERENCES permissions(code),
  requested_by  int NOT NULL REFERENCES users(id),
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','expired','executed')),
  decided_by    int REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)   -- DB-level two-person rule
);
CREATE UNIQUE INDEX approvals_one_pending ON approval_requests (job_id, action) WHERE status = 'pending';

-- ---------- History ----------
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_id     int REFERENCES users(id),
  on_behalf_of int REFERENCES users(id),       -- set when acting through an absence delegation
  event        text NOT NULL,                  -- job.created, job.transition, grant.created, access.denied ...
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  job_id       int,
  outcome      text NOT NULL CHECK (outcome IN ('allow','deny','info')),
  reason_code  text,
  detail       jsonb NOT NULL DEFAULT '{}',    -- before/after snapshots, grant used, failed checks
  request_id   uuid
);
CREATE INDEX audit_job_idx    ON audit_log (job_id, at);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id, at);
CREATE INDEX audit_actor_idx  ON audit_log (actor_id, at);
CREATE INDEX audit_event_idx  ON audit_log (event, at);
