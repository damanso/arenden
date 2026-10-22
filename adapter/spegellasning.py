#!/usr/bin/env python3
"""Lasningen och domen i spegelprovet for arendespegeln.

FR-18, B-17 punkten Tre utfall, Story 10.2. Spegelprovet i drift for in
modulen utanfor bygget.

Invarianter:
1. Varje post i katalogen med ett arendenamn gar genom las_fil i ett enda
   try. En fil raknas som last bara nar las_fil returnerat; varje undantag
   gor den till en post i olasbara med namn och undantagets typ. Darfor ar
   filer alltid lasta plus antalet olasbara, och en fil som inte gar att
   lasa svaljs aldrig tyst.
2. Datumformerna ar en sluten tabell (DATUMFORMER). Allt annat ger en
   olasbar fil, aldrig en gissning.
3. doma provar i fast ordning: katalogfel, olasbara filer, tom katalog,
   alder. GRON nas bara nar ingen fil ar olasbar och minst en fil lastes.
4. Exitkoden kommer bara ur UTFALL. huvud fangar varje undantag och ger
   KUNDE_INTE, sa en krasch i korningen blir aldrig 1, som ar ROD.
"""

import os
import re
import sys
from datetime import datetime
from typing import NamedTuple, Optional

ARENDEFIL = re.compile(r"LOC-[0-9]+\.md")
DATUMFORMER = (
    (r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}", "%Y-%m-%d %H:%M"),
    (r"[0-9]{4}-[0-9]{2}-[0-9]{2}", "%Y-%m-%d"),
)


class Lasning(NamedTuple):
    katalogfel: Optional[str]
    filer: int
    lasta: int
    senaste: Optional[str]
    olasbara: tuple[tuple[str, str], ...]


def las_fil(sokvag: str) -> str:
    with open(sokvag, "rb") as fil:
        text = fil.read().decode("utf-8")
    huvud = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", text, re.DOTALL)
    if huvud is None:
        raise ValueError("inget huvud")
    falt = {}
    for rad in re.split(r"\r?\n", huvud.group(1)):
        traff = re.fullmatch(r"([a-zA-Z_]+):\s*(.*)", rad)
        if traff is not None:
            falt[traff.group(1)] = traff.group(2).strip()
    varde = falt.get("uppdaterad", falt.get("skapad"))
    if varde is None:
        raise ValueError("inget datum")
    if len(varde) >= 2 and varde[0] in ("'", '"') and varde[-1] == varde[0]:
        varde = varde[1:-1]
    for monster, form in DATUMFORMER:
        if re.fullmatch(monster, varde):
            return datetime.strptime(varde, form).isoformat(sep=" ", timespec="minutes")
    raise ValueError("okand datumform")


def las_spegeln(katalog: str) -> Lasning:
    try:
        namnlista = os.listdir(katalog)
    except Exception as fel:
        return Lasning(type(fel).__name__, 0, 0, None, ())
    filer = 0
    lasta = 0
    senaste = None
    olasbara = []
    for namn in sorted(namnlista):
        if not ARENDEFIL.fullmatch(namn):
            continue
        filer += 1
        try:
            datum = las_fil(os.path.join(katalog, namn))
        except Exception as fel:
            olasbara.append((namn, type(fel).__name__))
        else:
            lasta += 1
            if senaste is None or datum > senaste:
                senaste = datum
    return Lasning(None, filer, lasta, senaste, tuple(olasbara))


UTFALL = {"GRON": 0, "ROD": 1, "KUNDE_INTE": 2}


class Dom(NamedTuple):
    utfall: str
    kod: int
    rader: tuple[str, ...]


def doma(lasning: Lasning, katalog: str, nu: datetime, grans_minuter: int) -> Dom:
    sammanfattning = "spegeln: filer=%d lasta=%d olasbara=%d senaste=%s" % (
        lasning.filer, lasning.lasta, len(lasning.olasbara), lasning.senaste or "-",
    )
    if lasning.katalogfel is not None:
        utfall = "KUNDE_INTE"
        rader = (
            "KUNDE_INTE: spegelkatalogen gar inte att lasa: %s (%s)" % (katalog, lasning.katalogfel),
            sammanfattning,
        )
    elif lasning.olasbara:
        utfall = "KUNDE_INTE"
        rader = (
            "KUNDE_INTE: %d av %d spegelfiler gar inte att lasa" % (len(lasning.olasbara), lasning.filer),
            sammanfattning,
        ) + tuple("olasbar: %s (%s)" % post for post in lasning.olasbara)
    elif lasning.filer == 0:
        utfall = "KUNDE_INTE"
        rader = ("KUNDE_INTE: inga spegelfiler i %s" % katalog, sammanfattning)
    else:
        senaste = datetime.strptime(lasning.senaste, DATUMFORMER[0][1])
        alder = int((nu - senaste).total_seconds() // 60)
        if alder > grans_minuter:
            utfall = "ROD"
            rader = (
                "ROD: spegeln har stannat",
                sammanfattning,
                "LARM: senaste uppdaterad %s ar %d minuter gammal, gransen ar %d minuter" % (
                    lasning.senaste, alder, grans_minuter,
                ),
            )
        else:
            utfall = "GRON"
            rader = ("GRON: spegeln ar farsk", sammanfattning)
    return Dom(utfall, UTFALL[utfall], rader)


def huvud(argument: list[str]) -> int:
    try:
        giltigt = len(argument) in (2, 3)
        if giltigt:
            giltigt = re.fullmatch(r"[0-9]+", argument[1]) is not None
        nu = datetime.now().replace(second=0, microsecond=0)
        if giltigt and len(argument) == 3:
            giltigt = re.fullmatch(DATUMFORMER[0][0], argument[2]) is not None
            if giltigt:
                try:
                    nu = datetime.strptime(argument[2], DATUMFORMER[0][1])
                except ValueError:
                    giltigt = False
        if not giltigt:
            print("KUNDE_INTE: anropet gar inte att tolka: <katalog> <grans_minuter> [<nu>]")
            return UTFALL["KUNDE_INTE"]
        katalog = argument[0]
        grans = int(argument[1])
        lasning = las_spegeln(katalog)
        dom = doma(lasning, katalog, nu, grans)
        for rad in dom.rader:
            print(rad)
        return dom.kod
    except Exception as fel:
        print("KUNDE_INTE: provet stannade: %s" % type(fel).__name__)
        return UTFALL["KUNDE_INTE"]


if __name__ == "__main__":
    sys.exit(huvud(sys.argv[1:]))
