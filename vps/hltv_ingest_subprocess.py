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
DAYS = int(os.getenv("HLTV_INGEST_DAYS", "2"))


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

    try:
        matches = list_recent_matches(days=DAYS)
        print(f"[hltv] discovered {len(matches)} matches in last {DAYS}d", flush=True)
        for m in matches:
            try:
                n = ingest_match(m, DEMOS_DIR)
                if n:
                    print(
                        f"[hltv] ingested {n} demos for {m.team_a} vs {m.team_b} "
                        f"({m.hltv_id})",
                        flush=True,
                    )
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
