-- =====================================================================
-- reference.sql : permissions, roles, workflow and rules.
-- This is CONFIGURATION, not code. Loaded by `npm run seed`.
-- =====================================================================

INSERT INTO permissions (code, description, is_dangerous) VALUES
  ('job.view',              'See a job in lists and details (without internal fields)', false),
  ('job.view_internal',     'See internal-only job fields (notes, customs ref, staff names)', false),
  ('job.view_history',      'See the audit history of a job', false),
  ('job.create',            'Create a job', false),
  ('job.update',            'Edit job data (only while confirmed or reopened)', false),
  ('job.prepare',           'Prepare a job (confirmed/reopened -> prepared)', false),
  ('job.check',             'Check a job (prepared -> checked)', false),
  ('job.file',              'File a job with customs (checked -> filed)', false),
  ('job.cancel',            'Cancel a job that is not yet filed', false),
  ('job.cancel_filed',      'Cancel a FILED job (needs reason + second approver)', true),
  ('job.reopen',            'Reopen a filed or cancelled job (needs reason + second approver)', true),
  ('job.reassign',          'Assign a job to a person; see unattended jobs', false),
  ('job.admin_fix',         'Audited override: send a stuck job back to an earlier stage', true),
  ('job.approve_dangerous', 'Approve another person''s cancel-filed / reopen request', true),
  ('access.view',           'See who has what access', false),
  ('access.grant',          'Create grants (bounded by role_grant_rights and own scope)', true),
  ('access.revoke',         'End grants / disable users (bounded the same way)', true),
  ('absence.manage',        'Record absences and delegations (bounded by own scope)', false),
  ('role.manage',           'Create roles and edit non-system roles', true),
  ('audit.read',            'Search the audit log and ask "who could act on date X"', false);

INSERT INTO roles (code, name, actor_types, delegable, is_system) VALUES
  ('maker',         'Maker',         '{staff}',  true,  true),
  ('checker',       'Checker',       '{staff}',  true,  true),
  ('filer',         'Filer',         '{staff}',  true,  true),
  ('supervisor',    'Supervisor',    '{staff}',  false, true),
  ('controller',    'Controller',    '{staff}',  false, true),
  ('access_admin',  'Access Admin',  '{staff}',  false, true),
  ('client_viewer', 'Client Viewer', '{client}', false, true),
  ('system_parser', 'System (Parser)', '{system}', false, true);

INSERT INTO role_permissions (role_id, permission_code, valid_from)
SELECT r.id, x.perm, TIMESTAMPTZ '2020-01-01 00:00:00+00'
FROM (VALUES
  ('maker','job.view'), ('maker','job.view_internal'), ('maker','job.create'), ('maker','job.update'), ('maker','job.prepare'),
  ('checker','job.view'), ('checker','job.view_internal'), ('checker','job.check'),
  ('filer','job.view'), ('filer','job.view_internal'), ('filer','job.file'),
  ('supervisor','job.view'), ('supervisor','job.view_internal'), ('supervisor','job.view_history'),
  ('supervisor','job.cancel'), ('supervisor','job.reassign'), ('supervisor','absence.manage'),
  ('controller','job.view'), ('controller','job.view_internal'), ('controller','job.view_history'),
  ('controller','job.cancel'), ('controller','job.reassign'), ('controller','absence.manage'),
  ('controller','job.cancel_filed'), ('controller','job.reopen'), ('controller','job.approve_dangerous'),
  ('access_admin','job.view'), ('access_admin','job.view_history'), ('access_admin','job.admin_fix'),
  ('access_admin','access.view'), ('access_admin','access.grant'), ('access_admin','access.revoke'),
  ('access_admin','role.manage'), ('access_admin','audit.read'),
  ('client_viewer','job.view'),
  ('system_parser','job.view'), ('system_parser','job.create'), ('system_parser','job.update')
) AS x(role_code, perm)
JOIN roles r ON r.code = x.role_code;

-- Workflow: actions that move a job
INSERT INTO job_transitions (action, from_stage, to_stage, in_worklist, requires_reason, requires_approval) VALUES
  ('job.prepare',     'confirmed', 'prepared',  true,  false, false),
  ('job.prepare',     'reopened',  'prepared',  true,  false, false),
  ('job.check',       'prepared',  'checked',   true,  false, false),
  ('job.file',        'checked',   'filed',     true,  false, false),
  ('job.cancel',      'confirmed', 'cancelled', false, true,  false),
  ('job.cancel',      'prepared',  'cancelled', false, true,  false),
  ('job.cancel',      'checked',   'cancelled', false, true,  false),
  ('job.cancel',      'reopened',  'cancelled', false, true,  false),
  ('job.cancel_filed','filed',     'cancelled', false, true,  true),
  ('job.reopen',      'filed',     'reopened',  false, true,  true),
  ('job.reopen',      'cancelled', 'reopened',  false, true,  true);

-- Actions that do not move a job, and the stages they are allowed in
INSERT INTO action_stages (action, stage)
SELECT p.code, s.stage
FROM permissions p
CROSS JOIN (VALUES ('confirmed'),('prepared'),('checked'),('filed'),('cancelled'),('reopened')) AS s(stage)
WHERE p.code IN ('job.view','job.view_internal','job.view_history');

INSERT INTO action_stages (action, stage) VALUES
  ('job.update',  'confirmed'), ('job.update',  'reopened'),
  ('job.reassign','confirmed'), ('job.reassign','prepared'), ('job.reassign','checked'), ('job.reassign','reopened'),
  ('job.admin_fix','prepared'), ('job.admin_fix','checked'), ('job.admin_fix','reopened'),
  ('job.approve_dangerous','filed'), ('job.approve_dangerous','cancelled');

-- Separation of duties
INSERT INTO sod_rules (action, actor_column) VALUES
  ('job.check', 'prepared_by'),   -- the preparer may not check the same job
  ('job.file',  'checked_by');    -- the checker may not file the same job

-- Who may hand out which role (Access Admin can NOT hand out Controller or Access Admin)
INSERT INTO role_grant_rights (granter_role_id, grantable_role_id)
SELECT g.id, t.id FROM roles g JOIN roles t ON t.code IN ('maker','checker','filer','supervisor','client_viewer','system_parser')
WHERE g.code = 'access_admin';

-- Roles one person may not hold at the same time
INSERT INTO role_conflicts (role_a, role_b)
SELECT a.id, b.id FROM roles a JOIN roles b ON b.code IN ('maker','checker','filer')
WHERE a.code = 'access_admin';
