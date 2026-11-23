-- Comms and reports C-4/A-22 (UTM campaigns, legacy `campaign` table and admin's campaign
-- screens): a marketing campaign is a set of UTM values staff create to tag a link, with what
-- was spent on it. Clicks are counted per campaign and per Kuwait day, so a day's clicks can be
-- read back and no row is updated in place (legacy incremented one counter and lost the history).
-- Signups and revenue are not here: attribution at signup belongs to the access lane and
-- revenue to the pay lane, so the page shows them as not available until those land.
CREATE TABLE marketing_campaigns (
 id uuid PRIMARY KEY,
 utm_source text NOT NULL CHECK (utm_source = btrim(utm_source) AND char_length(utm_source) BETWEEN 1 AND 100),
 utm_medium text NOT NULL CHECK (utm_medium = btrim(utm_medium) AND char_length(utm_medium) BETWEEN 1 AND 100),
 utm_campaign text NOT NULL CHECK (utm_campaign = btrim(utm_campaign) AND char_length(utm_campaign) BETWEEN 1 AND 100),
 utm_content text CHECK (utm_content IS NULL OR (utm_content = btrim(utm_content) AND char_length(utm_content) BETWEEN 1 AND 100)),
 utm_term text CHECK (utm_term IS NULL OR (utm_term = btrim(utm_term) AND char_length(utm_term) BETWEEN 1 AND 100)),
 investment numeric(12,3) NOT NULL DEFAULT 0 CHECK (investment >= 0),
 legacy_utm_uuid text UNIQUE,
 created_by_principal_id text REFERENCES principals(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 retired_at timestamptz
);
-- One LIVE campaign per set of UTM values: two links tagged the same way are the same campaign.
-- NULLS NOT DISTINCT so an empty content or term still counts as the same tag (plain UNIQUE in
-- Postgres treats NULLs as distinct, which would let the same link be two campaigns). Retired
-- campaigns are left out, so their UTM values can be used again by a new live campaign.
CREATE UNIQUE INDEX marketing_campaigns_utm_live_idx ON marketing_campaigns(utm_source, utm_medium, utm_campaign, utm_content, utm_term) NULLS NOT DISTINCT WHERE retired_at IS NULL;
CREATE INDEX marketing_campaigns_live_idx ON marketing_campaigns(utm_campaign, id) WHERE retired_at IS NULL;

CREATE FUNCTION enforce_marketing_campaign() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'campaigns are kept; retire it instead' USING ERRCODE = '23514'; END IF;
 IF NEW.created_at <> OLD.created_at OR NEW.legacy_utm_uuid IS DISTINCT FROM OLD.legacy_utm_uuid THEN
  RAISE EXCEPTION 'a campaign cannot change when it was created or which legacy campaign it is' USING ERRCODE = '23514';
 END IF;
 IF OLD.retired_at IS NOT NULL AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
  RAISE EXCEPTION 'a retired campaign cannot change' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER marketing_campaigns_rules BEFORE UPDATE OR DELETE ON marketing_campaigns FOR EACH ROW EXECUTE FUNCTION enforce_marketing_campaign();

-- One row per campaign and Kuwait day; the click endpoint adds to the day's count.
CREATE TABLE marketing_campaign_clicks (
 campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id),
 day date NOT NULL,
 clicks integer NOT NULL CHECK (clicks > 0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (campaign_id, day)
);
CREATE FUNCTION enforce_marketing_campaign_clicks() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'click counts are kept' USING ERRCODE = '23514'; END IF;
 IF NEW.campaign_id <> OLD.campaign_id OR NEW.day <> OLD.day OR NEW.clicks < OLD.clicks THEN
  RAISE EXCEPTION 'a day''s clicks only go up' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER marketing_campaign_clicks_rules BEFORE UPDATE OR DELETE ON marketing_campaign_clicks FOR EACH ROW EXECUTE FUNCTION enforce_marketing_campaign_clicks();
