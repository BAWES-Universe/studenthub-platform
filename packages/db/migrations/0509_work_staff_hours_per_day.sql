-- Work lane: each staff member's hours per day (legacy `staff.hours_per_day`).
--
-- Legacy's staff hours export counted a day with no minutes as the staff
-- record's hours per day (a tinyint, 8 unless set). StudentHub keeps that
-- number per principal here; the export reads it. A principal with no row
-- reads as legacy's default, 8 (as a staff record made in legacy would).
--
-- Rows come from the legacy import (M-5 seam: the cutover lane reads the
-- mirror and resolves the staff id, the work lane maps and writes). Like 0508,
-- an imported row keeps the digest of what was imported, so a re-run writes
-- nothing and a changed number is reported, never overwritten.

CREATE TABLE work_staff_hours_per_day (
  staff_principal_id text PRIMARY KEY REFERENCES principals(id),
  hours smallint NOT NULL CHECK (hours BETWEEN 0 AND 24),
  legacy_ref text UNIQUE CHECK (legacy_ref IS NULL OR legacy_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'),
  legacy_digest text CHECK (legacy_digest IS NULL OR legacy_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_staff_hours_per_day_legacy_digest CHECK (legacy_digest IS NULL OR legacy_ref IS NOT NULL)
);
CREATE TRIGGER work_staff_hours_per_day_import_digest BEFORE INSERT ON work_staff_hours_per_day FOR EACH ROW EXECUTE FUNCTION require_work_import_digest();

-- Who a row is for and where it came from are fixed once written; only the
-- number may change (and then the importer reports the row, never resets it).
CREATE FUNCTION refuse_work_staff_hours_key_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.staff_principal_id <> OLD.staff_principal_id OR NEW.legacy_ref IS DISTINCT FROM OLD.legacy_ref
    OR NEW.legacy_digest IS DISTINCT FROM OLD.legacy_digest OR NEW.created_at <> OLD.created_at THEN
  RAISE EXCEPTION 'staff hours per day: only the hours change' USING ERRCODE = '23514';
 END IF;
 NEW.updated_at := now();
 RETURN NEW;
END $$;
CREATE TRIGGER work_staff_hours_per_day_key BEFORE UPDATE ON work_staff_hours_per_day FOR EACH ROW EXECUTE FUNCTION refuse_work_staff_hours_key_change();
