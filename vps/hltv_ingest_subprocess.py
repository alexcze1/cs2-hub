# vps/hltv_ingest_subprocess.py
#
# Runs one HLTV ingest cycle in a fresh Python subprocess.
#
# Why a subprocess: sync_playwright().__enter__ inspects the calling thread's
# asyncio state. Running it under uvicorn's event loop — even via
# run_in_executor — left partial dispatcher state on the worker thread after a
# first-cycle failure, and subsequent cycles tripped Playwright's
# "Sync API inside the asyncio loop" guard. A child process has no parent loop
# to confuse the guard and starts with completely clean state.
#
# Invoked by main._hltv_ingest_once via `python -m hltv_ingest_subprocess`.
# Exits 0 on a clean cycle (even if no demos were ingested), non-zero on an
# unexpected error so the parent can log it.

from __future__ import annotations

import os
import sys
from pathlib import Path


DEMOS_DIR = Path(os.getenv("DEMOS_DIR", "/opt/midround/demos"))
DAYS = int(os.getenv("HLTV_INGEST_DAYS", "30"))
# Cap on *new* demos ingested per cycle. The window walks 30 days every run
# to backfill any gaps, but a fresh catchup can have hundreds of new matches
# in the gap — downloading all of them in one cycle blows the 2-hour
# subprocess deadline in main._hltv_ingest_once. Stopping at MAX_PER_CYCLE
# spreads the backfill across multiple 15-min cycles; the unique index +
# _already_ingested short-circuit make each subsequent cycle resume cheaply.
# 0 disables the cap.
MAX_PER_CYCLE = int(os.getenv("HLTV_INGEST_MAX_PER_CYCLE", "50"))


def main() -> int:
    # Imported here (not at module top) so an import error surfaces with a
    # readable traceback in the subprocess's stderr instead of an opaque
    # ModuleNotFoundError at parent-process start time.
    from hltv_scraper import (
        DiskCapExceeded,
        HLTVBlockedError,
        list_recent_matches,
        shutdown_playwright,
    )
    from hltv_ingest import ingest_match

    DEMOS_DIR.mkdir(parents=True, exist_ok=True)

    # Drop any team-uploaded .dem files older than 14 days before the cycle
    # starts. Public demos already self-clean after parse (see _process_one's
    # cleanup branch); team uploads stay forever because the parser keeps
    # them around for potential re-parses. Over weeks they fill the disk and
    # trip the SOFT_CAP_BYTES check, which silently stalls the ingest at 2-3
    # matches per cycle. match_data + slim are already in Supabase Storage
    # for every parsed demo, so deleting a 6 week old .dem just means a
    # re-parse would have to re-download from Storage first.
    import time as _time
    import shutil as _shutil
    cutoff_ts = _time.time() - 14 * 86400
    freed_bytes = 0
    freed_count = 0
    for p in DEMOS_DIR.glob("*.dem"):
        try:
            st = p.stat()
            if st.st_mtime < cutoff_ts:
                freed_bytes += st.st_size
                p.unlink()
                freed_count += 1
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"[hltv] prune skip {p.name}: {e}", flush=True)
    if freed_count:
        print(f"[hltv] pruned {freed_count} stale .dem files ({freed_bytes / 1024**3:.1f} GB freed)", flush=True)

    # Also sweep download-temp leftovers. A SIGKILL'd cycle (subprocess
    # deadline hit, OOM) skips the `finally` in download_demos that would
    # have removed these, so over time .tmp-*.archive (rar/zip blobs, hundreds
    # of MB) and .tmp-extract-* dirs accumulate and burn the SOFT_CAP_BYTES.
    # 1-hour cutoff: well past any real download, well short of pinning
    # genuinely in-progress work from a sibling worker (we run one subprocess
    # at a time so this is mostly defensive).
    tmp_cutoff_ts = _time.time() - 3600
    tmp_freed_bytes = 0
    tmp_freed_count = 0
    for p in list(DEMOS_DIR.glob(".tmp-*.archive")) + list(DEMOS_DIR.glob(".staged-*.dem")):
        try:
            st = p.stat()
            if st.st_mtime < tmp_cutoff_ts:
                tmp_freed_bytes += st.st_size
                p.unlink()
                tmp_freed_count += 1
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"[hltv] tmp prune skip {p.name}: {e}", flush=True)
    for d in DEMOS_DIR.glob(".tmp-extract-*"):
        try:
            if not d.is_dir():
                continue
            if d.stat().st_mtime < tmp_cutoff_ts:
                tmp_freed_bytes += sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
                _shutil.rmtree(d, ignore_errors=True)
                tmp_freed_count += 1
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"[hltv] tmp prune skip {d.name}: {e}", flush=True)
    if tmp_freed_count:
        print(f"[hltv] pruned {tmp_freed_count} stale download temps ({tmp_freed_bytes / 1024**3:.1f} GB freed)", flush=True)

    try:
        matches = list_recent_matches(days=DAYS)
        print(f"[hltv] discovered {len(matches)} matches in last {DAYS}d", flush=True)
        cycle_total = 0
        for m in matches:
            try:
                n = ingest_match(m, DEMOS_DIR)
                if n:
                    cycle_total += n
                    print(
                        f"[hltv] ingested {n} demos for {m.team_a} vs {m.team_b} "
                        f"({m.hltv_id}) — cycle total {cycle_total}",
                        flush=True,
                    )
                    if MAX_PER_CYCLE and cycle_total >= MAX_PER_CYCLE:
                        # Bail cleanly so main's wrapper records a successful
                        # cycle and the 15-min loop schedules the next one;
                        # already-ingested matches we already walked past are
                        # cheap to re-skip on the next pass.
                        print(
                            f"[hltv] reached MAX_PER_CYCLE={MAX_PER_CYCLE}, "
                            f"stopping cycle (continues next run)",
                            flush=True,
                        )
                        return 0
            except DiskCapExceeded as e:
                print(f"[hltv] disk cap reached, stopping cycle: {e}", flush=True)
                return 0
            except HLTVBlockedError as e:
                print(f"[hltv] Cloudflare block, stopping cycle: {e}", flush=True)
                return 0
            except Exception as e:
                print(
                    f"[hltv] skip {m.hltv_id} ({type(e).__name__}): {e}",
                    flush=True,
                )
    finally:
        # Always tear down Chromium so the subprocess exits cleanly.
        try:
            shutdown_playwright()
        except Exception:
            pass

    return 0


if __name__ == "__main__":
    sys.exit(main())
