-- Access lane A2: a company owner invites people to the team by email.
--
-- Only a SHA-256 hash of the 32-byte link token is stored. The grant is not
-- created here: it is created when the invitee accepts (used_at, used_by),
-- through the same grants / authorization_mutation_audit / access_grant_events
-- transaction the Access page uses.

CREATE TABLE company_invitations (
  id                        UUID PRIMARY KEY,
  org_id                    TEXT NOT NULL REFERENCES organizations (id),
  role                      TEXT NOT NULL CHECK (role IN ('org-owner', 'recruiter', 'finance')),
  scope                     TEXT NOT NULL CHECK (scope IN ('self', 'subtree')),
  invited_email_normalized  TEXT NOT NULL CHECK (
    char_length(invited_email_normalized) BETWEEN 3 AND 254
    AND invited_email_normalized = lower(btrim(invited_email_normalized))
  ),
  token_hash                CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by                TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at                TIMESTAMPTZ NOT NULL,
  used_at                   TIMESTAMPTZ,
  used_by                   TEXT,
  revoked_at                TIMESTAMPTZ,
  revoked_by                TEXT,
  CHECK (expires_at > created_at),
  CHECK ((used_at IS NULL) = (used_by IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (used_at IS NULL OR revoked_at IS NULL)
);

-- The Team page's pending list and the 50-per-company cap.
CREATE INDEX company_invitations_pending_idx
  ON company_invitations (org_id, created_at DESC)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- One pending invitation per company, role and address. An expired one is
-- revoked by the next invite for the same key inside its transaction.
CREATE UNIQUE INDEX company_invitations_one_pending_idx
  ON company_invitations (org_id, role, invited_email_normalized)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- Owner counts for the last-owner guard.
CREATE INDEX IF NOT EXISTS grants_org_role_idx ON grants (org_id, role);
