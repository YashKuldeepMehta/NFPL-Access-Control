export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export class ValidationError extends AppError {
  constructor(message, issues) { super(400, 'VALIDATION_ERROR', message, { issues }); }
}
export class NotFound extends AppError {
  constructor(message = 'Not found') { super(404, 'NOT_FOUND', message); }
}
export class Conflict extends AppError {
  constructor(code, message) { super(409, code, message); }
}
/**
 * 403. `audit` (optional) is written to audit_log as an `access.denied` row AFTER the
 * transaction rolled back, so a denied attempt is never lost together with the rollback.
 */
export class Forbidden extends AppError {
  constructor(code, message, { decision, audit } = {}) {
    super(403, code, message, decision ? { decision } : {});
    this.audit = audit;
  }
}
