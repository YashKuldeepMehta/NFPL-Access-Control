-- =====================================================================
-- 002_guards.sql : database-level guarantees that application bugs cannot break
--   1. audit_log is append-only
--   2. a job's scope (client/branch/direction/mode) never changes, which keeps
--      point-in-time reconstruction ("who could act on the 3rd") sound
--   3. grants are never deleted, never rewritten, never back-dated
-- =====================================================================

CREATE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

CREATE FUNCTION jobs_scope_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.mode IS DISTINCT FROM OLD.mode THEN
    RAISE EXCEPTION 'job scope (client, branch, direction, mode) is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_scope_guard
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_scope_immutable();

CREATE FUNCTION grants_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'grants are never deleted: end them by setting valid_to';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.role_id IS DISTINCT FROM OLD.role_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.direction IS DISTINCT FROM OLD.direction OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.reason IS DISTINCT FROM OLD.reason THEN
    RAISE EXCEPTION 'a grant can only be ended, never rewritten';
  END IF;
  IF NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
    IF OLD.valid_to IS NOT NULL AND NEW.valid_to > OLD.valid_to THEN
      RAISE EXCEPTION 'a grant cannot be extended once ended; create a new grant';
    END IF;
    IF NEW.valid_to < now() - interval '1 minute' THEN
      RAISE EXCEPTION 'a grant cannot be ended retroactively';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER grants_no_rewrite
  BEFORE UPDATE OR DELETE ON grants
  FOR EACH ROW EXECUTE FUNCTION grants_guard();
