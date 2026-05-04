-- One-shot cleanup: strip the `de_` prefix from any map name stored inside
-- vods.maps. Earlier auto-fill runs wrote raw csgo ids (e.g. "de_ancient")
-- into vod slots while the rest of the codebase uses the bare "ancient" form.
-- Idempotent — re-running is a no-op once all rows are clean.
--
-- Run in the Supabase SQL editor.

-- 1. Preview rows that will change. Run this first to sanity-check.
SELECT id, opponent, match_date, maps
FROM vods
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(maps) AS elem
  WHERE elem->>'map' ILIKE 'de\_%' ESCAPE '\'
);

-- 2. Perform the update.
UPDATE vods
SET maps = (
  SELECT jsonb_agg(
    CASE
      WHEN elem->>'map' ILIKE 'de\_%' ESCAPE '\'
      THEN jsonb_set(elem, '{map}', to_jsonb(lower(substring(elem->>'map' FROM 4))))
      ELSE elem
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(maps) WITH ORDINALITY AS t(elem, ord)
)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(maps) AS elem
  WHERE elem->>'map' ILIKE 'de\_%' ESCAPE '\'
);

-- 3. Verify nothing remains.
SELECT count(*) AS remaining
FROM vods
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(maps) AS elem
  WHERE elem->>'map' ILIKE 'de\_%' ESCAPE '\'
);
