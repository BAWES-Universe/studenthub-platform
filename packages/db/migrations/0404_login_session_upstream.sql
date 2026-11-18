-- Access lane A5: signing out ends the session everywhere.
--
-- A session keeps the issuer's session reference (the identity token's sid
-- claim, nothing more: no identity, access or refresh token is stored) and
-- two times. last_checked_at is set by every upstream check whatever its
-- answer, through a conditional UPDATE that lets one request win the right to
-- check; last_confirmed_at is set only by an answer of active, so an unknown
-- answer can never postpone the 2*T fail-closed bound. A session without a
-- reference is checked only by its own expiry, as before. The reference is
-- never a lookup key, so it needs no index; the checks go by the primary key.

ALTER TABLE login_sessions
  ADD COLUMN upstream_session_ref TEXT,
  ADD COLUMN last_confirmed_at    timestamptz,
  ADD COLUMN last_checked_at      timestamptz,
  -- Set when a claimed check ends without ending the session (an answer of
  -- active also moves last_confirmed_at to the claim time). A check is in
  -- flight while last_checked_at is later than both, and every other request
  -- for the session waits for it or fails closed; none rides on the old row.
  ADD COLUMN last_settled_at      timestamptz;
