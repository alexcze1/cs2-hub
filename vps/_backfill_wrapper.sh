#!/bin/bash
# vps/_backfill_wrapper.sh — restart backfill_hltv.py on transient exit.
# Idempotent matches mean re-runs skip already-fetched matches via the
# unique source_match_id index.

set -a
. /opt/midround/vps/.env
set +a
export HOME=/home/midround
export HLTV_FORCE_PLAYWRIGHT=1
export HLTV_DEMOS_DIR_SOFT_CAP_BYTES=32212254720   # 30 GB
export DEMOS_DIR=/opt/midround/demos
export PYTHONUNBUFFERED=1
cd /opt/midround/vps

attempt=1
while [ $attempt -le 50 ]; do
  echo "[wrapper] === backfill attempt $attempt — $(date -u) ==="
  /opt/midround/vps/.venv/bin/python3 -u backfill_hltv.py --days 90 --per-match-sleep 20
  rc=$?
  echo "[wrapper] backfill exited rc=$rc at $(date -u)"
  if [ $rc -eq 0 ]; then
    echo "[wrapper] all done"
    break
  fi
  echo "[wrapper] sleeping 20 min before retry"
  sleep 1200
  attempt=$((attempt+1))
done
