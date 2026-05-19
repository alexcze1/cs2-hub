# vps/hltv_ingest.py
#
# Glue between hltv_scraper (HLTV → archive → .dem) and the demos table.
# Idempotent: safe to call ingest_match repeatedly for the same MatchRef.
#
# Spec: docs/superpowers/specs/2026-05-18-public-pro-demos-design.md
# Plan: docs/superpowers/plans/2026-05-18-public-pro-demos.md

from __future__ import annotations

import logging
import uuid
from pathlib import Path

import psycopg2.errors

from db import get_db
from hltv_scraper import MatchRef, download_demos

log = logging.getLogger(__name__)


def ingest_match(match: MatchRef, demos_dir: Path) -> int:
    """Download + enqueue one HLTV match. Returns count of new demos inserted.

    Returns 0 when:
      - The match was already ingested in a previous run.
      - HLTV has no demo published for this match (live / cancelled / VOD-only).

    Raises whatever download_demos raises (HLTVBlockedError, DiskCapExceeded,
    extraction failures) — the caller decides how to back off.
    """
    if _already_ingested(match.hltv_id):
        return 0

    pairs = download_demos(match.url, demos_dir)
    if not pairs:
        log.warning("[hltv_ingest] no demos for match %s (%s vs %s)",
                    match.hltv_id, match.team_a, match.team_b)
        return 0

    inserted = 0
    for map_index, staged_path, _meta in pairs:
        demo_id = str(uuid.uuid4())
        final = demos_dir / f"{demo_id}.dem"
        staged_path.rename(final)
        try:
            _insert_pending_public(
                demo_id=demo_id,
                storage_path=f"local:{demo_id}.dem",
                source_match_id=match.hltv_id,
                source_map_index=map_index,
                source_url=match.url,
                event_name=match.event,
                team_a_name=match.team_a,
                team_b_name=match.team_b,
            )
            inserted += 1
        except psycopg2.errors.UniqueViolation:
            # Two workers ingested the same match in parallel; drop our copy.
            final.unlink(missing_ok=True)
            log.info("[hltv_ingest] (%s, %d) raced — already inserted by another worker",
                     match.hltv_id, map_index)
        except Exception:
            # Any other insert failure leaves an orphan .dem on disk; clean it.
            final.unlink(missing_ok=True)
            raise

    return inserted


def _already_ingested(hltv_id: str) -> bool:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM demos WHERE source = 'hltv' AND source_match_id = %s LIMIT 1",
                (hltv_id,),
            )
            return cur.fetchone() is not None


def _insert_pending_public(
    *,
    demo_id: str,
    storage_path: str,
    source_match_id: str,
    source_map_index: int,
    source_url: str,
    event_name: str,
    team_a_name: str,
    team_b_name: str,
) -> None:
    with get_db() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO demos
                  (id, team_id, uploaded_by, status, storage_path,
                   is_public, source, source_match_id, source_map_index,
                   source_url, event_name, team_a_name, team_b_name)
                VALUES
                  (%s, NULL, NULL, 'pending', %s,
                   TRUE, 'hltv', %s, %s,
                   %s, %s, %s, %s)
                """,
                (
                    demo_id, storage_path,
                    source_match_id, source_map_index,
                    source_url, event_name, team_a_name, team_b_name,
                ),
            )
