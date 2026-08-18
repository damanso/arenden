#!/usr/bin/env python3
"""Python-klient mot arendeplattformens actions-API (KRAV-18).

Samma sex funktioner som TS-adaptern (src/adapter/index.ts) och samma monster
som skillsens gql-hjalpare: ENDAST stdlib (urllib.request + json), ingen
tredjepart. Etapp 2:s skript importerar den har filen i stallet for att prata
GraphQL med Linear — inga befintliga skript ror vi nu.

Nyckeln lases i tur och ordning ur:
  1. argumentet `nyckel` till respektive funktion
  2. miljovariabeln ARENDEN_API_KEY
  3. filen ~/.hermes/arenden_nyckel  (eller ARENDEN_API_KEY_FIL)

Bas-URL:en tas ur ARENDEN_API_URL (default http://127.0.0.1:3002).

    from arenden_klient import list_issues, update_issue_state
    for a in list_issues(state_typer=["backlog", "unstarted"])["noder"]:
        print(a["identifier"], a["title"])
"""

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

BAS_URL = os.environ.get("ARENDEN_API_URL", "http://127.0.0.1:3002")
NYCKELFIL = Path(os.environ.get("ARENDEN_API_KEY_FIL", str(Path.home() / ".hermes/arenden_nyckel")))

STATE_TYPER = ("backlog", "unstarted", "started", "completed", "canceled")


class ArendeFel(RuntimeError):
    """API:t svarade med en felkod (t.ex. 401 utan giltig nyckel)."""

    def __init__(self, status, kod):
        super().__init__("arende-API svarade %s: %s" % (status, kod))
        self.status = status
        self.kod = kod


def _nyckel(nyckel=None):
    if nyckel:
        return nyckel
    ur_miljo = os.environ.get("ARENDEN_API_KEY")
    if ur_miljo:
        return ur_miljo
    try:
        return NYCKELFIL.read_text().strip()
    except OSError:
        raise ArendeFel(401, "ingen_nyckel")


def anropa(action, indata, nyckel=None, bas_url=None):
    """Kor en action. Aktoren tas ur nyckeln — aldrig ur indatat."""
    data = json.dumps(indata).encode("utf-8")
    begaran = urllib.request.Request(
        (bas_url or BAS_URL) + "/api/actions/" + action,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + _nyckel(nyckel),
        },
    )
    try:
        svar = json.loads(urllib.request.urlopen(begaran, timeout=60).read())
    except urllib.error.HTTPError as fel:
        try:
            kropp = json.loads(fel.read())
            kod = kropp.get("error", "okant_fel")
        except Exception:
            kod = "okant_fel"
        raise ArendeFel(fel.code, kod)
    return svar["result"]


def list_issues(state_typer=None, team_key=None, label=None, projekt=None,
                cursor=None, limit=None, nyckel=None, bas_url=None):
    """Paginerad listning. Motsvarar issues(first:, after:, filter:{state:{type:{in:}}})."""
    indata = {}
    if state_typer:
        indata["state_typer"] = list(state_typer)
    if team_key:
        indata["team_key"] = team_key
    if label:
        indata["label"] = label
    if projekt:
        indata["projekt"] = projekt
    if cursor:
        indata["cursor"] = cursor
    if limit:
        indata["limit"] = limit
    ut = anropa("list_issues", indata, nyckel, bas_url)
    return {
        "noder": ut["arenden"],
        "pageInfo": {
            "harNasta": ut["pageInfo"]["har_nasta"],
            "slutCursor": ut["pageInfo"]["slut_cursor"],
        },
    }


def get_workflow_states(team_key, nyckel=None, bas_url=None):
    """[{id, namn, typ}] — done_state-uppslaget ur linear_vakt/handelse_router."""
    return anropa("list_states", {"team_key": team_key}, nyckel, bas_url)


def create_issue(titel, team_key, beskrivning=None, labels=None, priority=None,
                 due=None, nyckel=None, bas_url=None):
    """-> {id, identifier}. Motsvarar issueCreate."""
    indata = {"title": titel, "team_key": team_key}
    if beskrivning:
        indata["description"] = beskrivning
    if labels:
        indata["labels"] = list(labels)
    if priority is not None:
        indata["priority"] = priority
    if due:
        indata["due"] = due
    ut = anropa("create_issue", indata, nyckel, bas_url)
    return {"id": ut["id"], "identifier": ut["identifier"]}


def update_issue_state(identifier, state_typ_eller_id, nyckel=None, bas_url=None):
    """Andra argumentet far vara en state-TYP ('completed') eller ett state-ID."""
    if state_typ_eller_id in STATE_TYPER:
        indata = {"identifier": identifier, "state_typ": state_typ_eller_id}
    else:
        indata = {"identifier": identifier, "state_id": state_typ_eller_id}
    return anropa("update_issue_state", indata, nyckel, bas_url)


def add_comment(identifier, body, nyckel=None, bas_url=None):
    """Motsvarar commentCreate. Aktoren stamplas ur nyckeln."""
    return anropa("add_comment", {"identifier": identifier, "body": body}, nyckel, bas_url)


def sok_label(namn, nyckel=None, bas_url=None):
    """-> id eller None. Motsvarar issueLabels(filter:{name:{eq:}})."""
    return anropa("sok_label", {"namn": namn}, nyckel, bas_url)["id"]
