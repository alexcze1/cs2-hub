# vps/hltv_rankings.py
#
# Scrape HLTV's /ranking/teams page for the current top-N team list + their
# rosters. Used by hltv_refresh_subprocess.py to populate hltv_teams /
# hltv_players in the cs2-hub Supabase project.
#
# Selectors are validated against the live HTML structure as of 2026-05-27.
# If HLTV redesigns, re-capture and update _parse_ranking_page / _parse_team_page.

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from bs4 import BeautifulSoup

from hltv_scraper import _get   # reuses the cloudscraper→Playwright transport

log = logging.getLogger(__name__)


@dataclass
class TeamInfo:
    id: int
    name: str
    rank: int | None
    logo_url: str | None


@dataclass
class PlayerInfo:
    id: int
    ign: str
    full_name: str | None
    team_id: int | None
    team_name: str | None
    country: str | None
    photo_url: str | None


# --------------------------------------------------------------------------- #
# /ranking/teams parser
# --------------------------------------------------------------------------- #

# Team page URL: /team/9565/vitality — capture id + slug
_TEAM_HREF_RE = re.compile(r"^/team/(\d+)/([^/]+)")
# Position cell: "#1"
_RANK_RE = re.compile(r"#(\d+)")


def list_ranked_teams(top_n: int = 30) -> list[TeamInfo]:
    """Fetch /ranking/teams and return the top `top_n` teams in rank order.

    Stops parsing after `top_n` rows so we don't iterate all ~250 ranked teams
    when the caller only wants the top 30. HLTV returns the full ranking in
    one HTML response (no pagination), so one fetch is enough.
    """
    html = _get("/ranking/teams")
    return _parse_ranking_page(html, top_n=top_n)


def _parse_ranking_page(html: str, *, top_n: int) -> list[TeamInfo]:
    """Parse one /ranking/teams page → list[TeamInfo] newest-rank first.

    Selector layout (validated live 2026-05-27):
      .ranked-team
        .position           "#N"
        .team-logo img      src = logo URL (img-cdn.hltv.org)
        .teamLine .name     team name
        a[href=/team/<id>/<slug>]   team id
    """
    soup = BeautifulSoup(html, "html.parser")
    out: list[TeamInfo] = []
    for row in soup.select(".ranked-team"):
        if len(out) >= top_n:
            break

        rank_text = (row.select_one(".position") or _Empty()).get_text(strip=True)
        rm = _RANK_RE.search(rank_text)
        rank = int(rm.group(1)) if rm else None

        # The first /team/<id>/<slug> anchor in this row is the canonical team link.
        team_id = None
        for a in row.find_all("a", href=True):
            m = _TEAM_HREF_RE.match(a["href"].strip())
            if m:
                team_id = int(m.group(1))
                break
        if team_id is None:
            continue

        name_el = row.select_one(".teamLine .name")
        if not name_el:
            continue
        name = name_el.get_text(strip=True)

        logo_el = row.select_one(".team-logo img.day-only") or row.select_one(".team-logo img")
        logo_url = logo_el.get("src") if logo_el else None

        out.append(TeamInfo(id=team_id, name=name, rank=rank, logo_url=logo_url))
    return out


def players_from_ranking_page(html: str, teams: list[TeamInfo]) -> list[PlayerInfo]:
    """Fallback parser — extracts IGN-only player rows from the ranking page.

    The rankings HTML lists each team's roster as plain text inside
    `.rankingNicknames span`. No HLTV player id and no photo, but we always
    get a name + team affiliation even when /team/<id>/<slug> is CF-blocked.

    Returns synthetic PlayerInfo records with id=None so the caller can decide
    how to dedupe / upsert.
    """
    soup = BeautifulSoup(html, "html.parser")
    teams_by_id = {t.id: t for t in teams}

    out: list[PlayerInfo] = []
    for row in soup.select(".ranked-team"):
        team_id = None
        for a in row.find_all("a", href=True):
            m = _TEAM_HREF_RE.match(a["href"].strip())
            if m:
                team_id = int(m.group(1))
                break
        team = teams_by_id.get(team_id) if team_id is not None else None
        if team is None:
            continue
        for span in row.select(".rankingNicknames span"):
            ign = span.get_text(strip=True)
            if not ign:
                continue
            out.append(PlayerInfo(
                id=None, ign=ign, full_name=None,
                team_id=team.id, team_name=team.name,
                country=None, photo_url=None,
            ))
    return out


# --------------------------------------------------------------------------- #
# /team/<id>/<slug> parser — yields the team's current 5-player roster
# --------------------------------------------------------------------------- #

# Player anchor: /player/<id>/<slug>
_PLAYER_HREF_RE = re.compile(r"^/player/(\d+)/([^/]+)")


def list_team_players(team: TeamInfo) -> list[PlayerInfo]:
    """Fetch /team/<id>/<slug> and return the listed roster as PlayerInfo.

    Returns [] (with a warning log) if the page can't be parsed — a per-team
    failure shouldn't take down the whole refresh cycle.
    """
    # HLTV's team URL slug is the lowercased name with dashes; the exact slug
    # is irrelevant because HLTV redirects /team/<id>/whatever → the canonical
    # URL. We use a lowercased best-effort slug.
    slug = re.sub(r"[^a-z0-9]+", "-", team.name.lower()).strip("-") or "team"
    try:
        html = _get(f"/team/{team.id}/{slug}")
    except Exception as e:
        log.warning("[rankings] team page fetch failed for %s (%s): %s", team.name, team.id, e)
        return []
    return _parse_team_page(html, team)


_TITLE_FULLNAME_RE = re.compile(r"^(.*?)\s+'([^']+)'\s+(.*)$")


def _parse_team_page(html: str, team: TeamInfo) -> list[PlayerInfo]:
    """Parse /team/<id>/<slug> → list[PlayerInfo].

    Selector layout (validated live 2026-05-27):
      a[href^=/player/<id>/]
        img.bodyshot-team-img
          src     = https://img-cdn.hltv.org/playerbodyshot/...
          title   = "First 'IGN' Last"   (full name, IGN in quotes)
          alt     = "Image of Counter-Strike player <IGN>"
        anchor.get_text() == "<IGN>"

    The page also contains the staff/historic players list further down with
    /player/ anchors — we cap at 8 entries to keep us in the current squad
    (5 starters + 1-2 substitutes).
    """
    soup = BeautifulSoup(html, "html.parser")

    # Prefer anchors that contain a bodyshot image — those are the current
    # squad. Fallback to any /player/ anchor if HLTV restyles.
    primary = [a for a in soup.select("a[href^='/player/']")
               if a.find("img", class_="bodyshot-team-img")]
    anchors = primary or soup.select("a[href^='/player/']")

    out: list[PlayerInfo] = []
    seen: set[int] = set()
    for a in anchors:
        m = _PLAYER_HREF_RE.match(a.get("href", "").strip())
        if not m:
            continue
        pid = int(m.group(1))
        if pid in seen:
            continue
        seen.add(pid)

        img = a.find("img")
        photo_url = img.get("src") if img else None
        # Anchor text is the bare IGN ("apEX"). Fall back to slug if empty.
        ign = a.get_text(strip=True) or m.group(2)
        # Full name: img.title is "Dan 'apEX' Madesclaire" — strip the IGN out.
        full_name = None
        if img and img.get("title"):
            tm = _TITLE_FULLNAME_RE.match(img["title"])
            if tm:
                full_name = f"{tm.group(1).strip()} {tm.group(3).strip()}".strip()
        out.append(PlayerInfo(
            id=pid, ign=ign, full_name=full_name,
            team_id=team.id, team_name=team.name,
            country=None, photo_url=photo_url,
        ))
        if len(out) >= 8:  # 5 starters + a few subs/coaches
            break
    return out


class _Empty:
    """Stand-in so .get_text() doesn't NPE when a selector misses."""
    def get_text(self, *_, **__): return ""


# --------------------------------------------------------------------------- #
# CLI for fixture capture / smoke test
# --------------------------------------------------------------------------- #


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) >= 2 and sys.argv[1] == "smoke":
        n = int(sys.argv[2]) if len(sys.argv) >= 3 else 5
        teams = list_ranked_teams(top_n=n)
        print(json.dumps([t.__dict__ for t in teams], indent=2))
        if teams:
            print(json.dumps([p.__dict__ for p in list_team_players(teams[0])], indent=2))
        from hltv_scraper import shutdown_playwright
        shutdown_playwright()
    else:
        print("usage: python -m hltv_rankings smoke [top_n]")
        sys.exit(2)
