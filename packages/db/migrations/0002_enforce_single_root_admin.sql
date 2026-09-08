-- SHU-55 (GPT R3, blocker #2): the one-root-admin rule must be a database
-- property, not a pre-write SELECT in bootstrap-admin.ts. Two concurrent
-- bootstrap processes can both pass that SELECT and each insert an admin
-- grant at the root org (TOCTOU). A partial unique index makes a second
-- admin@root row impossible no matter how it is attempted — bootstrap race,
-- grantMany, hand-written SQL: the loser fails with unique-violation 23505
-- on this constraint and the whole statement rolls back.
--
-- Only the ROOT org is special (bootstrap's target). Admin grants at other
-- organizations are ordinary data and stay unrestricted: the platform has
-- one root admin; everyone else is granted admin at their own org.
CREATE UNIQUE INDEX IF NOT EXISTS one_root_admin_grant
  ON grants (org_id)
  WHERE org_id = 'root' AND role = 'admin';
