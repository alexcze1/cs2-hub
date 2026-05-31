-- cs2-hub/supabase-hltv-vetos-migration.sql
--
-- Stores per-match veto sequences scraped from HLTV match pages, so the
-- veto-simulator can show a team's recent veto behaviour and predict
-- their next bans/picks.
--
-- One row per HLTV match (across all maps — the veto sequence is shared
-- across maps of a series). match_id is the HLTV match id (numeric string
-- from the URL — e.g. '2394931'). sequence is the parsed step list:
--   [{ "order": 1, "team": "TYLOO", "action": "ban",  "map": "dust2"   },
--    { "order": 2, "team": "SemperFi", "action": "ban",  "map": "overpass" },
--    { "order": 7, "team": null,     "action": "decider", "map": "anubis" }]

CREATE TABLE IF NOT EXISTS hltv_team_vetos (
  match_id    text        PRIMARY KEY,
  played_at   timestamptz,
  team_a_name text        NOT NULL,
  team_b_name text        NOT NULL,
  format      text,                       -- 'bo1' | 'bo3' | 'bo5'
  sequence    jsonb       NOT NULL,
  scraped_at  timestamptz NOT NULL DEFAULT now()
);

-- Lookups by team-name (case-insensitive) drive the simulator's history fetch.
CREATE INDEX IF NOT EXISTS idx_hltv_vetos_team_a_low ON hltv_team_vetos (lower(team_a_name));
CREATE INDEX IF NOT EXISTS idx_hltv_vetos_team_b_low ON hltv_team_vetos (lower(team_b_name));
CREATE INDEX IF NOT EXISTS idx_hltv_vetos_played_at  ON hltv_team_vetos (played_at DESC);

-- Anyone can read (the simulator is part of the team-scouting UX); writes
-- come from the VPS service-role key only.
ALTER TABLE hltv_team_vetos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS hltv_vetos_read_all ON hltv_team_vetos;
CREATE POLICY hltv_vetos_read_all ON hltv_team_vetos FOR SELECT USING (true);
