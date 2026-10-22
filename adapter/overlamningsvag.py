#!/usr/bin/env python3
"""Overlamningsvagen (FR-30, B-17 punkten Overlamningen, Story 10.6).

Overlamning.py i drift for in denna modul utanfor bygget.
1. Klassningen har fast ordning: utan rekommendation, extern, intern, okand.
   Indatat har sluten form; allt annat ar ValueError.
2. arendeindata bygger exakt fyra falt, aldrig projekt eller enhet. Steg har
   tre steg utan byggsteg. Analysen ar en beslutsfraga, bygget efter Davids ja (17/8).
3. leverera kor skapa_arende, spara, starta_analys i ett enda try. Varje
   undantag stoppar foljande steg. Avvisad nar inget steg; intern bara spara.
4. Exitkoden kommer bara ur UTFALL. huvud tolkar anropet fore lasningen;
   skriptets steg skriver bara i katalogen som --ut anger.
"""
import json
import re
import sys
from pathlib import Path
from typing import NamedTuple, Optional

import arenden_klient

RUBRIKPREFIX = "[Fr\u00e5n Hermes] "
ETIKETT = "Fr\u00e5n-Hermes"
# Teamet jamfors med driftens anrop vid inforandet.
TEAM_KEY = "LOC"
# PRD FR-30, driftens arendetext rad 253-257: jamfors vid inforandet.
FORE_ARBETET = "Mottagaren fr\u00e5gar David om en f\u00f6r- och nackdelsanalys innan arbetet b\u00f6rjar (Davids direktiv 17/8)."
# Driftens avvisning (PRD FR-30 Acceptans, rad 234-242), skriven i ASCII.
UTAN_REKOMMENDATION = "en overlamning utan rekommendation ar arbete som skickats vidare, inte ett problem som lamnats over"
NYCKLAR = ("mottagare", "rubrik", "text", "rekommendation")
MOTTAGARNAMN = re.compile(r"[a-z][a-z0-9_-]{0,63}")


class Overlamning(NamedTuple):
    mottagare: str
    rubrik: str
    text: Optional[str]
    rekommendation: Optional[str]


class Mottagare(NamedTuple):
    externa: tuple
    interna: tuple


class Klass(NamedTuple):
    slag: str
    skal: Optional[str]


# Sluten lista: inget steg bygger nagot; bygget startar pa Davids ja utanfor vagen.
class Steg(NamedTuple):
    skapa_arende: object
    spara: object
    starta_analys: object


def tolka_overlamning(data):
    if not isinstance(data, dict) or not set(data).issubset(NYCKLAR):
        raise ValueError("overlamningens falt")
    for namn in ("mottagare", "rubrik"):
        if not isinstance(data.get(namn), str) or not data[namn].strip():
            raise ValueError(namn)
    for namn in ("text", "rekommendation"):
        if data.get(namn) is not None and not isinstance(data[namn], str):
            raise ValueError(namn)
    return Overlamning(*(data.get(namn) for namn in NYCKLAR))


def tolka_mottagare(data):
    if not isinstance(data, dict) or set(data) != {"externa", "interna"}:
        raise ValueError("mottagarlistornas falt")
    sedda = set()
    for lista in (data["externa"], data["interna"]):
        if not isinstance(lista, list):
            raise ValueError("mottagarlista")
        for namn in lista:
            if not isinstance(namn, str) or not MOTTAGARNAMN.fullmatch(namn) or namn in sedda:
                raise ValueError("mottagarnamn")
            sedda.add(namn)
    return Mottagare(tuple(data["externa"]), tuple(data["interna"]))


def bedom(overlamning, mottagare):
    if overlamning.rekommendation is None or not overlamning.rekommendation.strip():
        return Klass("avvisad", UTAN_REKOMMENDATION)
    if overlamning.mottagare in mottagare.externa:
        return Klass("extern", None)
    if overlamning.mottagare in mottagare.interna:
        return Klass("intern", None)
    return Klass("avvisad", "okand mottagare: " + overlamning.mottagare)


def beskrivningstext(overlamning):
    delar = []
    if overlamning.text is not None and overlamning.text.strip():
        delar.append(overlamning.text)
    delar.extend(("Rekommendation: " + overlamning.rekommendation, FORE_ARBETET))
    return "\n\n".join(delar)


def arendeindata(overlamning):
    return {"titel": RUBRIKPREFIX + overlamning.rubrik, "team_key": TEAM_KEY,
            "beskrivning": beskrivningstext(overlamning), "labels": [ETIKETT]}


def analysindata(overlamning, arende):
    return {"slag": "beslutsfraga", "arende": arende, "mottagare": overlamning.mottagare,
            "rubrik": overlamning.rubrik, "rekommendation": overlamning.rekommendation,
            "bygge": "efter_davids_ja"}


UTFALL = {"OVERLAMNAD": 0, "MISSLYCKAD": 1, "AVVISAD": 2}


class Resultat(NamedTuple):
    utfall: str
    kod: int
    rader: tuple
    arende: Optional[str]


def beskriv(fel):
    return "%s %s" % (fel.status, fel.kod) if hasattr(fel, "status") and hasattr(fel, "kod") else type(fel).__name__


def leverera(overlamning, mottagare, steg):
    klass = bedom(overlamning, mottagare)
    if klass.slag == "avvisad":
        return Resultat("AVVISAD", UTFALL["AVVISAD"], ("AVVISAD: " + klass.skal,), None)
    arende = None
    try:
        if klass.slag == "extern":
            namn = "create_issue"
            svar = steg.skapa_arende(**arendeindata(overlamning))
            identifier = svar["identifier"]
            if not isinstance(identifier, str) or not identifier.strip():
                raise ValueError("identifier")
            arende = identifier
            namn = "spara"
            steg.spara(overlamning, arende)
            namn = "starta_analys"
            steg.starta_analys(analysindata(overlamning, arende))
            rad = "OVERLAMNAD: %s fick %s, analysen ar en beslutsfraga och bygget vantar pa Davids ja" % (overlamning.mottagare, arende)
        else:
            namn = "spara"
            steg.spara(overlamning, None)
            rad = "OVERLAMNAD: %s ar intern, inget arende skapas" % overlamning.mottagare
        return Resultat("OVERLAMNAD", UTFALL["OVERLAMNAD"], (rad,), arende)
    except Exception as fel:
        if namn == "starta_analys":
            rad = "MISSLYCKAD: starta_analys gav %s, arende %s, overlamningen ar sparad men analysen startades inte" % (beskriv(fel), arende)
        else:
            rad = "MISSLYCKAD: %s gav %s, arende %s, overlamningen ar inte sparad och ingen analys startades" % (namn, beskriv(fel), arende or "inget")
        return Resultat("MISSLYCKAD", UTFALL["MISSLYCKAD"], (rad,), arende)


ANROPSRAD = "FEL: anropet gar inte att tolka: --overlamning <fil> --mottagare <fil> --ut <katalog>"
OVERLAMNADE = "overlamnade.jsonl"
BESLUTSFRAGOR = "beslutsfragor.jsonl"


def las_fil(sokvag):
    return json.loads(Path(sokvag).read_bytes().decode("utf-8"))


def katalogsteg(ut):
    # Driftens overlamning.py har egna steg: fil, yta, valvcommit och CTO-fraga.
    def spara(overlamning, arende):
        Path(ut).mkdir(parents=True, exist_ok=True)
        rad = {"mottagare": overlamning.mottagare, "rubrik": overlamning.rubrik,
               "rekommendation": overlamning.rekommendation, "arende": arende}
        with (Path(ut) / OVERLAMNADE).open("a", encoding="utf-8") as fil:
            fil.write(json.dumps(rad) + "\n")

    def starta_analys(fraga):
        Path(ut).mkdir(parents=True, exist_ok=True)
        with (Path(ut) / BESLUTSFRAGOR).open("a", encoding="utf-8") as fil:
            fil.write(json.dumps(fraga) + "\n")

    return spara, starta_analys


def tolka_anrop(argument):
    if len(argument) != 6:
        return None
    varden = {}
    for flagga, varde in zip(argument[::2], argument[1::2]):
        if (flagga not in ("--overlamning", "--mottagare", "--ut") or flagga in varden
                or not isinstance(varde, str) or not varde or varde.startswith("--")):
            return None
        varden[flagga] = varde
    return varden["--overlamning"], varden["--mottagare"], varden["--ut"]


def huvud(argument):
    try:
        anrop = tolka_anrop(argument)
        if anrop is None:
            print(ANROPSRAD)
            return UTFALL["AVVISAD"]
        overlamningsfil, mottagarfil, ut = anrop
        try:
            mottagare = tolka_mottagare(las_fil(mottagarfil))
        except Exception as fel:
            print("FEL: mottagarfilen gar inte att lasa (%s)" % type(fel).__name__)
            return UTFALL["AVVISAD"]
        try:
            overlamning = tolka_overlamning(las_fil(overlamningsfil))
        except Exception as fel:
            print("FEL: overlamningen gar inte att lasa (%s)" % type(fel).__name__)
            return UTFALL["AVVISAD"]
        resultat = leverera(overlamning, mottagare, Steg(arenden_klient.create_issue, *katalogsteg(ut)))
        for rad in resultat.rader:
            print(rad)
        return resultat.kod
    except Exception as fel:
        print("FEL: overlamningen stannade: %s" % type(fel).__name__)
        return UTFALL["MISSLYCKAD"]


if __name__ == "__main__":
    sys.exit(huvud(sys.argv[1:]))
