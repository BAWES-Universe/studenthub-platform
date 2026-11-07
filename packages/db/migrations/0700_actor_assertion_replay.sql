-- Tombstones are scoped by issuer. Never replace a conflicting row on consume.
CREATE TABLE actor_assertion_replay (
  issuer text NOT NULL CHECK (length(issuer) > 0),
  jti text NOT NULL CHECK (length(jti) > 0),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  PRIMARY KEY (issuer, jti)
);
CREATE INDEX actor_assertion_replay_expiry_idx ON actor_assertion_replay(expires_at);

-- A SQL WHERE evaluated before an INSERT lock wait is insufficient: the token
-- can expire while blocked. Both decisions below use fresh wall time, including
-- inside an old transaction. A refused token may leave a tombstone (fail closed).
CREATE FUNCTION consume_actor_assertion(
  p_issuer text, p_jti text, p_exp timestamptz,
  p_iat timestamptz, p_skew integer
) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  decision_time timestamptz;
  inserted_count integer;
BEGIN
  IF p_exp IS NULL OR NOT isfinite(p_exp)
     OR (p_iat IS NULL) <> (p_skew IS NULL)
     OR (p_iat IS NOT NULL AND (NOT isfinite(p_iat) OR p_skew < 0 OR p_skew > 300)) THEN
    RAISE EXCEPTION 'invalid actor assertion replay constraints';
  END IF;
  decision_time := clock_timestamp();
  IF p_exp <= decision_time THEN RETURN 'expired'; END IF;
  IF p_iat > decision_time + p_skew * interval '1 second' THEN RETURN 'future_iat'; END IF;

  INSERT INTO actor_assertion_replay(issuer, jti, expires_at)
  VALUES (p_issuer, p_jti, p_exp) ON CONFLICT (issuer, jti) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  decision_time := clock_timestamp();
  IF p_exp <= decision_time THEN RETURN 'expired'; END IF;
  IF p_iat > decision_time + p_skew * interval '1 second' THEN RETURN 'future_iat'; END IF;
  IF inserted_count = 1 THEN RETURN 'consumed'; END IF;
  RETURN 'replayed';
END;
$$;
