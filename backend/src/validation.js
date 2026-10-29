import { z } from 'zod';
import { ValidationError } from './errors.js';

export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new ValidationError('Invalid request',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

const id = z.coerce.number().int().positive();
const nullableId = z.number().int().positive().nullable().optional();
const direction = z.enum(['import', 'export']);
const mode = z.enum(['air', 'fcl', 'lcl']);
const reason = z.string().trim().min(3, 'a reason of at least 3 characters is required').max(500);
const isoDate = z.string().datetime({ offset: true }).or(z.string().datetime());

export const schemas = {
  id,
  pagination: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.coerce.number().int().min(0).default(0),
  }),
  worklistQuery: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.coerce.number().int().min(0).default(0),
    assigned: z.enum(['any', 'me', 'unassigned']).default('any'),
  }),
  jobsQuery: z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.coerce.number().int().min(0).default(0),
    stage: z.enum(['confirmed', 'prepared', 'checked', 'filed', 'cancelled', 'reopened']).optional(),
    client_id: z.coerce.number().int().positive().optional(),
    branch_id: z.coerce.number().int().positive().optional(),
  }),
  createJob: z.object({
    client_id: z.number().int().positive(),
    branch_id: z.number().int().positive(),
    direction,
    mode,
    internal_notes: z.string().max(2000).optional(),
    customs_ref: z.string().max(200).optional(),
  }).strict(),
  updateJob: z.object({
    internal_notes: z.string().max(2000).nullable().optional(),
    customs_ref: z.string().max(200).nullable().optional(),
  }).strict().refine((o) => Object.keys(o).length > 0, 'nothing to update'),
  actionBody: z.object({
    reason: reason.optional(),
    approval_id: z.number().int().positive().optional(),
  }).strict(),
  reassign: z.object({ owner_id: z.number().int().positive().nullable(), reason: reason.optional() }).strict(),
  adminFix: z.object({ to_stage: z.enum(['confirmed', 'prepared', 'checked']), reason }).strict(),
  approvalRequest: z.object({ action: z.string().min(3), reason }).strict(),
  approvalDecision: z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(500).optional(),
  }).strict(),
  canQuery: z.object({
    user: z.coerce.number().int().positive().optional(),
    action: z.string().min(1),
    job: z.coerce.number().int().positive(),
  }),
  compareQuery: z.object({
    a: z.coerce.number().int().positive(),
    b: z.coerce.number().int().positive(),
    action: z.string().min(1),
    job: z.coerce.number().int().positive(),
  }),
  whoCouldActQuery: z.object({
    at: isoDate,
    action: z.string().min(1).optional(),
  }),
  auditQuery: z.object({
    actor: z.coerce.number().int().positive().optional(),
    event: z.string().optional(),
    job: z.coerce.number().int().positive().optional(),
    outcome: z.enum(['allow', 'deny', 'info']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    before_id: z.coerce.number().int().positive().optional(),
  }),
  createGrant: z.object({
    user_id: z.number().int().positive(),
    role_code: z.string().min(2),
    client_id: nullableId,
    branch_id: nullableId,
    direction: direction.nullable().optional(),
    mode: mode.nullable().optional(),
    valid_from: isoDate.optional(),
    valid_to: isoDate.nullable().optional(),
    reason,
  }).strict(),
  endGrant: z.object({ reason }).strict(),
  createAbsence: z.object({
    user_id: z.number().int().positive(),
    delegate_id: z.number().int().positive().nullable().optional(),
    valid_from: isoDate,
    valid_to: isoDate,
    reason,
  }).strict(),
  disableUser: z.object({ reason }).strict(),
  createRole: z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/, 'lowercase letters, digits and _ (3-41 chars)'),
    name: z.string().trim().min(2).max(80),
    actor_types: z.array(z.enum(['staff', 'client', 'system'])).min(1).default(['staff']),
    delegable: z.boolean().default(false),
    permissions: z.array(z.string()).min(1),
  }).strict(),
  setRolePermissions: z.object({ permissions: z.array(z.string()).min(1), reason }).strict(),
};
