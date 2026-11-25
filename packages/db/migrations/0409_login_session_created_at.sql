-- Access lane U-03: the person's own account page lists where they are signed in.
--
-- A session records when it was created. Sessions that existed before this
-- migration keep NULL (the time is unknown, and the page says so) rather than
-- the migration time, which would be wrong; every new session gets now().
-- The column is read only by the person's own list, which goes by person_id,
-- so it adds an index on person_id (sign out everywhere deletes by it too).

ALTER TABLE login_sessions ADD COLUMN created_at timestamptz;
ALTER TABLE login_sessions ALTER COLUMN created_at SET DEFAULT now();
CREATE INDEX IF NOT EXISTS login_sessions_person_id_idx ON login_sessions (person_id);
