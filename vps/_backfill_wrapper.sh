#!/bin/bash
# vps/_backfill_wrapper.sh — continuous slow-trickle ingest of HLTV public demos.
#
# Designed to run forever as a background daemon on the VPS. Each loop walks
# the last 90 days of /results, sleeping 3 minutes between matches so the
# request rate stays well under Cloudflare's per-IP threshold (20 req/h vs
# the ~150 req/h that got the VPS flagged on 2026-05-27).
#
# Idempotent: matches already in the demos table are skipped via the unique
# (source, source_match_id, source_map_index) index — re-walks don't re-ingest.
#
# Launch with:
#   setsid sudo -u midround /opt/midround/vps/_backfill_wrapper.sh \
#     >> /opt/midround/demos/backfill.log 2>&1 < /dev/null &
#   disown
#
# Pair with HLTV_INGEST_ENABLED=0 + HLTV_REFRESH_ENABLED=0 in .env so the
# daily systemd loops don't launch a second Chromium and OOM the box.

set -a
. /opt/midround/vps/.env
set +a
export HOME=/home/midround
export HLTV_FORCE_PLAYWRIGHT=1
export HLTV_DEMOS_DIR_SOFT_CAP_BYTES=32212254720   # 30 GB
export DEMOS_DIR=/opt/midround/demos
export PYTHONUNBUFFERED=1
cd /opt/midround/vps

PER_MATCH_SLEEP=${HLTV_TRICKLE_PER_MATCH_SLEEP:-180}   # 3 min between matches
BETWEEN_WALKS_SLEEP=${HLTV_TRICKLE_BETWEEN_WALKS:-1800} # 30 min between full walks
WALK_DAYS=${HLTV_TRICKLE_DAYS:-90}

walk=1
while true; do
  echo "[trickle] === walk #$walk starting $(date -u) ==="
  echo "[trickle]   days=$WALK_DAYS per_match_sleep=${PER_MATCH_SLEEP}s"
  /opt/midround/vps/.venv/bin/python3 -u backfill_hltv.py \
    --days "$WALK_DAYS" --per-match-sleep "$PER_MATCH_SLEEP"
  rc=$?
  echo "[trickle] walk #$walk ended rc=$rc at $(date -u)"
  if [ $rc -ne 0 ]; then
    # rc=2 (HLTVBlockedError) or disk cap — let CF cool / parser drain.
    echo "[trickle] non-zero exit; sleeping 30 min before next walk"
    sleep 1800
  else
    echo "[trickle] walk complete; sleeping ${BETWEEN_WALKS_SLEEP}s before next walk"
    sleep "$BETWEEN_WALKS_SLEEP"
  fi
  walk=$((walk+1))
done
