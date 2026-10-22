#!/usr/bin/env python3
"""Staende prov for overlamningsvagen (FR-30, B-17, Story 10.6 AK 2).

I drift under kanalens prov_prefix arende; inforandet gors utanfor bygget.
1. KUNDE_INTE ges bara av importera nar klienten eller vagen inte kan importeras.
2. Inget anrop lamnar processen: create_issue ersatts med stubben och anropa
   med en raknande vakt fore varje fall. HOME och filer ar tillfalliga.
3. GRON kraver att alla sex fall stammer. Varje annan avvikelse ar ROD.
4. Exitkoden kommer bara ur UTFALL. huvud gor varje undantag till ROD.
"""
import contextlib
import importlib
import io
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple, Optional

UTFALL = {"GRON": 0, "ROD": 1, "KUNDE_INTE": 2}
RUBRIKPREFIX = "[Fr\u00e5n Hermes] "
ETIKETT = "Fr\u00e5n-Hermes"
FALTEN = {"titel", "team_key", "beskrivning", "labels"}
PROVMOTTAGARE = {"externa": ["sidoprojektet"], "interna": ["provets-roll"]}
ANROPSRAD = "ROD: anropet gar inte att tolka: [--moduler <katalog>]"
GRONRAD = "GRON: overlamningsvagen haller i alla sex fall"
RODRAD = "ROD: overlamningsvagen haller inte"


class Fall(NamedTuple):
    id: str
    namn: str
    overlamning: dict
    lage: str
    forvantan: tuple


OVERLAMNING = {"mottagare": "sidoprojektet", "rubrik": "Provets overlamning",
               "text": "Provets text.", "rekommendation": "Provets rekommendation."}
# Egna tal, aldrig vagens tabell: en andrad exitkod ska fallas av provet.
FALL = (
    Fall("P1", "utan rekommendation", {k: v for k, v in OVERLAMNING.items() if k != "rekommendation"}, "lyckas", (2, 0, 0, 0)),
    Fall("P2", "okand mottagare", dict(OVERLAMNING, mottagare="provets okanda mottagare"), "lyckas", (2, 0, 0, 0)),
    Fall("P3", "extern", dict(OVERLAMNING), "lyckas", (0, 1, 1, 1)),
    Fall("P4", "intern", dict(OVERLAMNING, mottagare="provets-roll"), "lyckas", (0, 0, 1, 0)),
    Fall("P5", "extern, svarar 400", dict(OVERLAMNING), "svarar_400", (1, 1, 0, 0)),
    Fall("P6", "extern, svarar inte", dict(OVERLAMNING), "svarar_inte", (1, 1, 0, 0)),
)


class Observation(NamedTuple):
    kod: Optional[int]
    skapade: list
    sparade: list
    analyser: list
    natanrop: int
    stannade: Optional[str]


def importera(katalog):
    sys.path.insert(0, str(katalog))
    try:
        namn = "arenden_klient"
        klient = importlib.import_module(namn)
        namn = "overlamningsvag"
        vag = importlib.import_module(namn)
        return klient, vag, None
    except Exception as fel:
        return None, None, "%s gar inte att importera (%s)" % (namn, type(fel).__name__)


def stubbe(klient, lage, skapade):
    def skapa(**argument):
        skapade.append(dict(argument))
        if lage == "svarar_400":
            raise klient.ArendeFel(400, "validation_error")
        if lage == "svarar_inte":
            raise TimeoutError("provets stubbe svarar inte")
        return {"id": "provets-id", "identifier": "PROV-1"}
    return skapa


def kor_fall(klient, vag, fall, rot):
    katalog = Path(rot) / fall.id
    katalog.mkdir()
    overlamning = katalog / "overlamning.json"
    mottagare = katalog / "mottagare.json"
    ut = katalog / "ut"
    overlamning.write_text(json.dumps(fall.overlamning), encoding="utf-8")
    mottagare.write_text(json.dumps(PROVMOTTAGARE), encoding="utf-8")
    skapade = []
    natanrop = 0

    def natvakt(*argument, **nyckelord):
        nonlocal natanrop
        natanrop += 1
        raise RuntimeError("provets natvakt")

    klient.create_issue = stubbe(klient, fall.lage, skapade)
    klient.anropa = natvakt
    kod, stannade = None, None
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            kod = vag.huvud(["--overlamning", str(overlamning), "--mottagare", str(mottagare), "--ut", str(ut)])
    except Exception as fel:
        stannade = type(fel).__name__

    def rader(namn):
        fil = ut / namn
        if not fil.exists():
            return []
        return [json.loads(rad) for rad in fil.read_text(encoding="utf-8").splitlines() if rad]

    return Observation(kod, skapade, rader(vag.OVERLAMNADE), rader(vag.BESLUTSFRAGOR), natanrop, stannade)


def innehall(fall, obs):
    for argument in obs.skapade:
        if (set(argument) != FALTEN
                or argument.get("titel") != RUBRIKPREFIX + fall.overlamning["rubrik"]
                or argument.get("labels") != [ETIKETT]):
            return False
    if fall.forvantan[3]:
        for fraga in obs.analyser:
            if (fraga.get("slag") != "beslutsfraga" or fraga.get("bygge") != "efter_davids_ja"
                    or fraga.get("arende") != "PROV-1"):
                return False
    return True


def stammer(fall, obs):
    return (obs.stannade is None and obs.natanrop == 0
            and (obs.kod, len(obs.skapade), len(obs.sparade), len(obs.analyser)) == fall.forvantan
            and innehall(fall, obs))


def fallrad(status, fall, obs):
    if obs.stannade is not None:
        return "AVVIKER %s %s: vagen stannade (%s)" % (fall.id, fall.namn, obs.stannade)
    tillagg = "" if innehall(fall, obs) else ", innehallet avviker"
    return "%s %s %s: kod %d, skapade %d, sparade %d, analyser %d, natanrop %d%s" % (
        status, fall.id, fall.namn, obs.kod, len(obs.skapade), len(obs.sparade),
        len(obs.analyser), obs.natanrop, tillagg)


def huvud(argument):
    try:
        if argument and not (len(argument) == 2 and argument[0] == "--moduler"
                             and isinstance(argument[1], str) and argument[1]
                             and not argument[1].startswith("--")):
            print(ANROPSRAD)
            return UTFALL["ROD"]
        katalog = argument[1] if argument else Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as rot:
            hem = Path(rot) / "hem"
            hem.mkdir()
            os.environ["HOME"] = str(hem)
            klient, vag, fel = importera(katalog)
            if fel is not None:
                print("KUNDE_INTE: " + fel)
                return UTFALL["KUNDE_INTE"]
            observationer = [(fall, kor_fall(klient, vag, fall, rot)) for fall in FALL]
            gron = all(stammer(fall, obs) for fall, obs in observationer)
            print(GRONRAD if gron else RODRAD)
            for fall, obs in observationer:
                print(fallrad("ok" if stammer(fall, obs) else "AVVIKER", fall, obs))
            return UTFALL["GRON" if gron else "ROD"]
    except Exception as fel:
        print("ROD: provet stannade: %s" % type(fel).__name__)
        return UTFALL["ROD"]


if __name__ == "__main__":
    sys.exit(huvud(sys.argv[1:]))
