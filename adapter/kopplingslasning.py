#!/usr/bin/env python3
"""Lasningen och domen i kopplingsprovet.

FR-31, B-17 punkten Tre utfall, Story 10.7. Kopplingsprovet i drift for in
modulen utanfor bygget.

Invarianter:
1. Varje register lases genom las_register i ett enda try som omsluter
   lasaren och formprovningen. Varje undantag ger ett Registerlage utan
   poster och med undantagets typ, sa poster ur ett register som inte gick
   att lasa fors aldrig vidare. REGISTER ar sluten, och kunddokument ar
   det enda namnregistret.
2. Manifestet och registren har en sluten form. Allt annat ar ett
   ValueError och darmed olasbart, aldrig en gissning.
3. KONTROLLER ar en sluten tabell for KONTROLL 4-6. Ett annat svar an det
   vantade, en konsument som stannar eller saknas gor kontrollen avvikande.
4. prova_koppling provar registrets fel forst: en koppling till ett
   olasbart register blir KUNDE_INTE och provas aldrig mot poster. doma
   provar olasbart underlag, inga ifyllda kopplingar, fel eller avvikande
   kontroll i den ordningen, och GRON sist.
5. Exitkoden kommer bara ur UTFALL. huvud laser ingenting innan anropet
   tolkats och gor varje undantag till KUNDE_INTE.
"""

import json
import os
import sys
from typing import NamedTuple, Optional

# PRD FR-31: redovisning och arenden ar id-register, kunddokument namnregistret.
REGISTER = ("redovisning", "arenden", "kunddokument")
NAMNREGISTER = "kunddokument"
MANIFESTNYCKLAR = ("manifest",) + REGISTER


class Registerlage(NamedTuple):
    register: str
    poster: Optional[tuple[tuple[str, str], ...] | tuple[str, ...]]
    fel: Optional[str]


class Manifest(NamedTuple):
    namn: str
    redovisning: Optional[str]
    arenden: Optional[str]
    kunddokument: Optional[str]


class Manifestlage(NamedTuple):
    manifest: Optional[tuple[Manifest, ...]]
    fel: Optional[str]


def las_json(sokvag):
    with open(sokvag, "rb") as fil:
        return json.loads(fil.read().decode("utf-8"))


def las_katalognamn(sokvag):
    with os.scandir(sokvag) as poster:
        return [post.name for post in poster if post.is_dir() and not post.name.startswith(".")]


def filregister(register, sokvag):
    # Kopplingsprovet i drift ger sina egna lasare till las_register i stallet.
    if register == NAMNREGISTER:
        return lambda: las_katalognamn(sokvag)
    return lambda: las_json(sokvag)


def tolka_idregister(data):
    if not isinstance(data, list):
        raise ValueError("registret ar ingen lista")
    poster = []
    sedda = set()
    for post in data:
        if not isinstance(post, dict) or set(post) != {"id", "namn"}:
            raise ValueError("postens nycklar")
        if any(not isinstance(post[f], str) or not post[f].strip() for f in ("id", "namn")):
            raise ValueError("postens varden")
        if post["id"] in sedda:
            raise ValueError("dubbelt id")
        sedda.add(post["id"])
        poster.append((post["id"], post["namn"]))
    return tuple(poster)


def tolka_namnlista(data):
    if not isinstance(data, (list, tuple)):
        raise ValueError("namnen ar ingen lista")
    if any(not isinstance(namn, str) or not namn.strip() for namn in data):
        raise ValueError("katalognamnets form")
    if len(set(data)) != len(data):
        raise ValueError("dubbelt katalognamn")
    return tuple(sorted(data))


def tolka_manifest(data):
    if not isinstance(data, list):
        raise ValueError("manifestet ar ingen lista")
    manifest = []
    sedda = set()
    for post in data:
        if not isinstance(post, dict) or not set(post).issubset(MANIFESTNYCKLAR):
            raise ValueError("manifestets nycklar")
        namn = post.get("manifest")
        if not isinstance(namn, str) or not namn.strip() or namn in sedda:
            raise ValueError("manifestets namn")
        varden = tuple(post.get(register) for register in REGISTER)
        if any(v is not None and (not isinstance(v, str) or not v.strip()) for v in varden):
            raise ValueError("kopplingens form")
        sedda.add(namn)
        manifest.append(Manifest(namn, *varden))
    return tuple(manifest)


def las_register(register, lasare):
    try:
        if register not in REGISTER:
            raise ValueError("okant register")
        data = lasare()
        poster = tolka_namnlista(data) if register == NAMNREGISTER else tolka_idregister(data)
        return Registerlage(register, poster, None)
    except Exception as fel:
        return Registerlage(register, None, type(fel).__name__)


def las_manifesten(sokvag):
    try:
        return Manifestlage(tolka_manifest(las_json(sokvag)), None)
    except Exception as fel:
        return Manifestlage(None, type(fel).__name__)


# Katalognamnet ar avsiktligt kundens namn: kontroll 4 och 6 provar samma
# strang at bada hallen (FR-31).
PROVREGISTER = {
    "redovisning": (("prov-kund-1", "Provkunden AB"),),
    "arenden": (("prov-projekt-1", "Provprojektet"),),
    "kunddokument": ("Provkunden AB",),
}
# PRD FR-31, KONTROLL 4-6 (rad 264-295 och 282-293). Numreringen jamfors
# med kopplingsprovet i drift vid inforandet.
KONTROLLER = (
    (4, "redovisning", (("prov-kund-1", "prov-kund-1"), ("Provkunden AB", None))),
    (5, "arenden", (("prov-projekt-1", "prov-projekt-1"), ("Provprojektet", None))),
    (6, "kunddokument", (("Provkunden AB", "Provkunden AB"), ("provkunden ab", None), ("prov-kund-1", None))),
)


def uppslag_id(varde, poster):
    return varde if any(id == varde for id, namn in poster) else None


def uppslag_namn(varde, poster):
    return varde if varde in poster else None


# Driftprovet ger sina riktiga konsumenter fran kopplingar.py, enhetslage.py
# och portfolj.py (kodgranskningen rad 48, forkrav i drift).
KONSUMENTER = {"redovisning": uppslag_id, "arenden": uppslag_id, "kunddokument": uppslag_namn}


class Kontroll(NamedTuple):
    nr: int
    register: str
    avvikelse: Optional[str]


def visa(svar):
    return "ingen traff" if svar is None else str(svar)


def kontrollera(konsumenter):
    kontroller = []
    for nr, register, fall in KONTROLLER:
        konsument = konsumenter.get(register)
        avvikelse = None
        if konsument is None:
            avvikelse = "ingen konsument"
        else:
            for varde, vantat in fall:
                try:
                    svar = konsument(varde, PROVREGISTER[register])
                except Exception:
                    avvikelse = "%s stannade konsumenten" % varde
                    break
                if svar != vantat:
                    avvikelse = "%s gav %s, vantat %s" % (varde, visa(svar), visa(vantat))
                    break
        kontroller.append(Kontroll(nr, register, avvikelse))
    return tuple(kontroller)


UTFALL = {"GRON": 0, "ROD": 1, "KUNDE_INTE": 2}
GRONRAD = "GRON: varje ifylld koppling finns i sitt register, och konsumenterna laser id:t"
RODRAD = "ROD: kopplingarna haller inte"
KUNDE_INTE_RAD = "KUNDE_INTE: delar av kopplingsprovet gar inte att prova"
# PRD FR-31 kraver att undantaget for kunddokument skrivs ut.
NAMNREGISTERRAD = (
    "kunddokument ar det enda namnregistret: katalognamnet ar hela identiteten, "
    "och en bar strang ar giltig dar"
)


class Provning(NamedTuple):
    manifest: str
    register: str
    varde: str
    status: str
    skal: Optional[str]


class Dom(NamedTuple):
    utfall: str
    kod: int
    rader: tuple[str, ...]


def prova_koppling(manifest, lage):
    varde = getattr(manifest, lage.register)
    status, skal = "ok", None
    if lage.fel is not None:
        status, skal = "KUNDE_INTE", "registret gar inte att lasa (%s)" % lage.fel
    elif lage.register == NAMNREGISTER:
        if varde not in lage.poster:
            status, skal = "FEL", "katalognamnet finns inte i registret"
    elif any(varde == id for id, namn in lage.poster):
        pass
    elif any(varde == namn for id, namn in lage.poster):
        status, skal = "FEL", "namnburen, vardet ar ett namn i registret och inget id"
    else:
        status, skal = "FEL", "id:t finns inte i registret"
    return Provning(manifest.namn, lage.register, varde, status, skal)


def prova_kopplingar(manifest, lagen):
    return tuple(prova_koppling(m, lage) for m in manifest for lage in lagen
                 if getattr(m, lage.register) is not None)


def doma(manifestlage, lagen, kontroller):
    manifest = manifestlage.manifest
    provningar = prova_kopplingar(manifest, lagen) if manifestlage.fel is None else ()
    ifyllda = len(provningar)
    ok = sum(p.status == "ok" for p in provningar)
    fel = sum(p.status == "FEL" for p in provningar)
    oprovade = sum(p.status == "KUNDE_INTE" for p in provningar)
    tomma = len(REGISTER) * len(manifest) - ifyllda if manifestlage.fel is None else 0
    if manifestlage.fel is not None or any(lage.fel is not None for lage in lagen):
        utfall, forsta = "KUNDE_INTE", KUNDE_INTE_RAD
    elif ifyllda == 0:
        utfall, forsta = "KUNDE_INTE", KUNDE_INTE_RAD
    elif fel > 0 or any(k.avvikelse is not None for k in kontroller):
        utfall, forsta = "ROD", RODRAD
    else:
        utfall, forsta = "GRON", GRONRAD
    rader = [forsta, NAMNREGISTERRAD,
             "kopplingar: ifyllda=%d ok=%d fel=%d oprovade=%d tomma=%d" % (
                 ifyllda, ok, fel, oprovade, tomma,
             )]
    if manifestlage.fel is not None:
        rader.append("manifesten gar inte att lasa (%s)" % manifestlage.fel)
    for lage in lagen:
        if lage.fel is not None:
            rader.append("register %s gar inte att lasa (%s)" % (lage.register, lage.fel))
    if manifestlage.fel is None and ifyllda == 0:
        rader.append("inga ifyllda kopplingar att prova")
    for p in provningar:
        if p.status != "ok":
            rader.append("koppling %s %s=%s: %s, %s" % p)
    for k in kontroller:
        text = "ok" if k.avvikelse is None else "AVVIKER, %s" % k.avvikelse
        rader.append("KONTROLL %d %s: %s" % (k.nr, k.register, text))
    return Dom(utfall, UTFALL[utfall], tuple(rader))


def kor(manifestfil, registerfiler):
    lagen = tuple(las_register(r, filregister(r, registerfiler[r])) for r in REGISTER)
    return doma(las_manifesten(manifestfil), lagen, kontrollera(KONSUMENTER))


ANROPSRAD = (
    "KUNDE_INTE: anropet gar inte att tolka: --manifest <fil> --redovisning <fil> "
    "--arenden <fil> --kunddokument <katalog>"
)
FLAGGOR = {"--redovisning": "redovisning", "--arenden": "arenden", "--kunddokument": "kunddokument"}


def tolka_anrop(argument):
    if len(argument) != 8:
        return None
    varden = {}
    for i in range(0, len(argument), 2):
        flagga, varde = argument[i:i + 2]
        if flagga not in ("--manifest", *FLAGGOR) or flagga in varden:
            return None
        if not isinstance(varde, str) or not varde or varde.startswith("--"):
            return None
        varden[flagga] = varde
    return varden["--manifest"], {register: varden[flagga] for flagga, register in FLAGGOR.items()}


def huvud(argument):
    try:
        anrop = tolka_anrop(argument)
        if anrop is None:
            print(ANROPSRAD)
            return UTFALL["KUNDE_INTE"]
        dom = kor(*anrop)
        for rad in dom.rader:
            print(rad)
        return dom.kod
    except Exception as fel:
        print("KUNDE_INTE: provet stannade: %s" % type(fel).__name__)
        return UTFALL["KUNDE_INTE"]


if __name__ == "__main__":
    sys.exit(huvud(sys.argv[1:]))
