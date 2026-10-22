#!/usr/bin/env python3
"""Hemplaceringens bedomning, mandatgrind och skrivvag.

FR-19, B-17 punkten Hemplaceringen, Story 10.3. Hemplaceringen i drift
for in modulen utanfor bygget.

Invarianter:
1. Varje arende i universum far exakt en bedomning ur bedom_arende,
   med en av nio koder i KODER.
2. Ett arende fran fore sparren placeras bara nar regelfilen klassar dess
   enda skapandehandelses aktor som annan och malet kommer ur ett
   beslutsbevis i BESLUTSBEVIS (#55-#57) och ar beslutets eget mal.
   Rollpass (#54) placeras aldrig. Allt annat redovisas med skal;
   utan regelfil placeras inget arende fran fore sparren.
3. Bevis ar titeltaggar i borjan av titeln och etiketter, matchade i tre
   nivaer: exakt, efter NFC och skiftlagesvikning, och genom ALIAS.
   Fler an ett mal ar motstridigt och placerar aldrig.

4. All lasning ar klar fore forsta skrivningen; ett lasfel stoppar
   korningen innan nagot skrivs.
5. Den enda skrivningen ar placeringsindata till update_issue: projektets
   namn ur registret (id:t lases aldrig in), bara_om_osatt alltid sant och
   skalet ordagrant. Varje skrivning ger en rad, och ett fel ger koden 1.

6. Hogarna maste bara exakt universums arenden, en gang var, innan nagot
   skrivs; annars skrivs inget och koden blir 2.
7. Exitkoden kommer bara ur UTFALL; huvud gor varje undantag till 2.

Kannetecknet: ett arende ar rollpass-skapat nar dess enda skapandehandelse
(verbet skapade_arende eller importerade_arende) har en aktor
(aktor_typ/aktor_namn) som regelfilen klassar som rollpass. Vilka aktorer
det ar star i #54:s original i beslutskon och fors in i regelfilen i drift;
modulen bar inga sadana namn.
"""

import json
import re
import sys
import unicodedata
from datetime import datetime, timezone
from typing import NamedTuple, Optional

import arenden_klient

# 28/9 kl. 00.00 svensk sommartid: sparrens driftsattning (PRD FR-19,
# portfoljenheter:s SPARR54_DATUM). Jamfors med driftens grans fore inforandet.
SPARR54_GRANS = datetime(2026, 9, 27, 22, 0, tzinfo=timezone.utc)
SKAPANDEVERB = ("skapade_arende", "importerade_arende")
AKTORSTYPER = ("manniska", "agent", "system")
KLASSER = ("rollpass", "annan")
ALIAS = {"admin": "Locollabs"}  # #55: Admin hor till Locollabs.
# Sluten tabell (Davids svar 2026-10-16, PRD FR-19 kallraden). Annat bevis
# placerar inte fore sparren. Beslutsbeviset maste traffa beslutets eget mal:
# ett projekt som heter Admin ar inte #55:s Locollabs.
BESLUTSBEVIS = {
    "admin": (55, "Locollabs"), "privat": (56, "Privat"),
    "ledning": (56, "Ledning"), "uppdrag": (56, "Uppdrag"),
    "importbrus": (57, "Importbrus"),
}
TITELTAGG = re.compile(r"\s*\[([^\[\]]{1,200})\]")
KODER = {
    "P1": "placeras", "P2": "placeras",
    "F1": "fragegrupper", "F2": "fragegrupper", "F3": "fragegrupper", "F4": "fragegrupper",
    "U1": "utan_vag", "U2": "utan_vag", "U3": "utan_vag",
}


class Arende(NamedTuple):
    identifier: str
    titel: str
    etiketter: tuple[str, ...]
    skapad: datetime
    skapare: Optional[tuple[tuple[str, str], ...]]


class Traff(NamedTuple):
    kalla: str
    varde: str
    projekt: str
    niva: int


class Regler(NamedTuple):
    skapare: dict[tuple[str, str], str]
    rader: tuple[tuple[str, str, str], ...]


class Regelutfall(NamedTuple):
    regler: Optional[Regler]
    orsak: Optional[str]


class Bedomning(NamedTuple):
    identifier: str
    kod: str
    projekt: Optional[str]
    text: str


def vik(text: str) -> str:
    return unicodedata.normalize("NFC", unicodedata.normalize("NFC", text).casefold())


def tolka_tid(text: str) -> datetime:
    tidpunkt = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    if tidpunkt.tzinfo is None or tidpunkt.utcoffset() is None:
        raise ValueError("tidpunkten saknar tidszon")
    return tidpunkt


def till_arende(rad, handelser) -> Arende:
    skapare = None if handelser is None else tuple(
        (h["aktor_typ"], h["aktor_namn"]) for h in handelser if h["verb"] in SKAPANDEVERB
    )
    return Arende(rad["identifier"], rad["title"], tuple(rad["labels"]), tolka_tid(rad["skapad"]), skapare)


def bevis(arende: Arende) -> list[tuple[str, str]]:
    resultat = []
    titel = arende.titel
    while True:
        traff = TITELTAGG.match(titel)
        if traff is None:
            break
        varde = traff.group(1).strip()
        if varde:
            resultat.append(("titeltagg", varde))
        titel = titel[traff.end():]
    return resultat + [("etikett", varde) for varde in arende.etiketter]


def traffar(varde: str, register: frozenset[str]) -> list[tuple[str, int]]:
    if varde in register:
        return [(varde, 1)]
    vikta = [(namn, 2) for namn in sorted(register) if vik(namn) == vik(varde)]
    if vikta:
        return vikta
    alias = ALIAS.get(vik(varde))
    return [(alias, 3)] if alias in register else []


def alla_traffar(arende: Arende, register: frozenset[str]) -> list[Traff]:
    return [Traff(kalla, varde, projekt, niva) for kalla, varde in bevis(arende)
            for projekt, niva in traffar(varde, register)]


def tolka_regler(text: str) -> Regler:
    data = json.loads(text)
    if not isinstance(data, dict) or set(data) != {"beslut", "skapare"}:
        raise ValueError("regelfilens nycklar")
    if type(data["beslut"]) is not int or data["beslut"] != 54:
        raise ValueError("regelfilens beslut")
    if not isinstance(data["skapare"], list) or not data["skapare"]:
        raise ValueError("regelfilens skapare")
    skapare = {}
    rader = []
    for rad in data["skapare"]:
        if not isinstance(rad, dict) or set(rad) != {"aktor_typ", "aktor_namn", "klass"}:
            raise ValueError("skaparradens nycklar")
        if rad["aktor_typ"] not in AKTORSTYPER or rad["klass"] not in KLASSER:
            raise ValueError("skaparradens typ eller klass")
        if not isinstance(rad["aktor_namn"], str) or not rad["aktor_namn"]:
            raise ValueError("skaparradens namn")
        aktor = (rad["aktor_typ"], rad["aktor_namn"])
        if aktor in skapare:
            raise ValueError("dubblerad skapare")
        skapare[aktor] = rad["klass"]
        rader.append((*aktor, rad["klass"]))
    return Regler(skapare, tuple(rader))


def las_regler(sokvag: Optional[str]) -> Regelutfall:
    if sokvag is None:
        return Regelutfall(None, "ingen regelfil")
    try:
        with open(sokvag, "rb") as fil:
            regler = tolka_regler(fil.read().decode("utf-8"))
        return Regelutfall(regler, None)
    except Exception as fel:
        return Regelutfall(None, "regelfilen gar inte att lasa (%s)" % type(fel).__name__)


def fore_sparren(arende: Arende) -> bool:
    return arende.skapad < SPARR54_GRANS


def bedom_arende(arende: Arende, register: frozenset[str], regelutfall: Regelutfall) -> Bedomning:
    fore = fore_sparren(arende)
    if fore:
        orsak = None
        if regelutfall.regler is None:
            orsak = regelutfall.orsak
        elif arende.skapare is None:
            orsak = "skapandehandelserna ar inte lasta"
        elif len(arende.skapare) != 1:
            orsak = "%d skapandehandelser" % len(arende.skapare)
        elif arende.skapare[0] not in regelutfall.regler.skapare:
            orsak = "%s/%s star inte i regelfilen" % arende.skapare[0]
        elif regelutfall.regler.skapare[arende.skapare[0]] == "rollpass":
            return Bedomning(arende.identifier, "U2", None,
                             "skapat av rollpass %s/%s, beslut #54" % arende.skapare[0])
        if orsak is not None or regelutfall.regler is None:
            return Bedomning(arende.identifier, "U3", None, "skaparen gar inte att avgora: " + str(orsak))

    alla = alla_traffar(arende, register)
    mal = {t.projekt for t in alla}
    if len(mal) > 1:
        return Bedomning(arende.identifier, "F2", None, "motstridiga bevis: " + ", ".join(sorted(mal)))
    if mal:
        traff = alla[0]
        beslut = None
        if fore:
            besluts_traffar = [t for t in alla if vik(t.varde) in BESLUTSBEVIS
                              and vik(t.projekt) == vik(BESLUTSBEVIS[vik(t.varde)][1])]
            if not besluts_traffar:
                return Bedomning(arende.identifier, "F3", None, "fore sparren, bevis utan beslut: " + traff.projekt)
            traff = besluts_traffar[0]
            beslut = BESLUTSBEVIS[vik(traff.varde)][0]
        text = 'hemplacering: %s "%s" ger %s (niva %d)' % traff
        if beslut is not None:
            text += "; fore sparren, beslut #%d" % beslut
        return Bedomning(arende.identifier, "P2" if fore else "P1", traff.projekt, text)
    bevisen = bevis(arende)
    if bevisen:
        return Bedomning(arende.identifier, "F1", None,
                         "omatchat bevis: " + ", ".join(dict.fromkeys(v for _, v in bevisen)))
    return Bedomning(arende.identifier, "F4" if fore else "U1", None,
                     "fore sparren, utan bevis" if fore else "inget bevis")


SIDSTORLEK = 100
SIDTAK = 1000


class Skrivning(NamedTuple):
    identifier: str
    projekt: str
    utfall: str


class Korning(NamedTuple):
    kod: int
    rader: tuple[str, ...]
    bedomningar: tuple[Bedomning, ...]
    skrivningar: tuple[Skrivning, ...]


def las_projekt(anropa) -> frozenset[str]:
    namn = []
    for rad in anropa("list_project_customers", {}):
        projekt = rad["projekt"]
        if not isinstance(projekt, str):
            raise ValueError("projektets namn ar inte en strang")
        namn.append(projekt)
    return frozenset(namn)


def las_universum(anropa) -> list[Arende]:
    universum = []
    indata = {"limit": SIDSTORLEK}
    for _ in range(SIDTAK):
        svar = anropa("list_issues", indata)
        for rad in svar["arenden"]:
            if rad["projekt"] is not None:
                continue
            arende = till_arende(rad, None)
            if fore_sparren(arende):
                handelser = anropa("get_issue", {"identifier": arende.identifier})["handelser"]
                arende = till_arende(rad, handelser)
            universum.append(arende)
        if not svar["pageInfo"]["har_nasta"]:
            return sorted(universum, key=lambda a: (a.identifier.rsplit("-", 1)[0],
                                                    int(a.identifier.rsplit("-", 1)[1])))
        indata = {"limit": SIDSTORLEK, "cursor": svar["pageInfo"]["slut_cursor"]}
    raise RuntimeError("sidtaket overskreds")


def bedom_alla(universum: list[Arende], register: frozenset[str], regelutfall: Regelutfall) -> list[Bedomning]:
    return [bedom_arende(a, register, regelutfall) for a in universum]


def placeringsindata(bedomning: Bedomning) -> dict:
    if KODER.get(bedomning.kod) != "placeras" or not isinstance(bedomning.projekt, str):
        raise ValueError("bedomningen ar inte en placering")
    return {"identifier": bedomning.identifier, "projekt": bedomning.projekt,
            "skal": bedomning.text, "bara_om_osatt": True}


def skriv_placeringar(anropa, bedomningar: list[Bedomning]) -> list[Skrivning]:
    skrivningar = []
    for b in bedomningar:
        if KODER.get(b.kod) != "placeras":
            continue
        try:
            svar = anropa("update_issue", placeringsindata(b))
            utfall = "andrad" if svar["andringar"] else "oforandrad"
        except Exception as fel:
            beskrivning = ("%s %s" % (fel.status, fel.kod)
                           if hasattr(fel, "status") and hasattr(fel, "kod") else type(fel).__name__)
            utfall = "fel " + beskrivning
        skrivningar.append(Skrivning(b.identifier, b.projekt, utfall))
    return skrivningar


def korning(anropa, regler_sokvag: Optional[str], skriv: bool) -> Korning:
    regelutfall = las_regler(regler_sokvag)
    universum = las_universum(anropa)
    register = las_projekt(anropa)
    bedomningar = bedom_alla(universum, register, regelutfall)
    if regelutfall.regler is None:
        rader = ["regel #54: %s, inget arende fran fore sparren placeras" % regelutfall.orsak]
    else:
        rader = ["regel #54: %s/%s ar %s" % rad for rad in regelutfall.regler.rader]
    rader.append("universum: %d hemlosa arenden, %d fran fore sparren" % (
        len(universum), sum(fore_sparren(a) for a in universum)))
    rader.extend("%s %s: %s" % (b.identifier, b.kod, b.text) for b in bedomningar)
    fordelning = hogar(bedomningar)
    sumfel = kontrollera_summan(fordelning, universum)
    if sumfel is not None:
        return Korning(UTFALL["AVBRUTEN"], tuple(rader + [sumfel]), tuple(bedomningar), ())
    antal = [len(fordelning[namn]) for namn in HOGAR]
    rader.append("hogar: placeras=%d fragegrupper=%d utan_vag=%d summa=%d universum=%d" %
                 (*antal, sum(antal), len(universum)))
    grupper = {}
    for b in fordelning["fragegrupper"]:
        grupper.setdefault(b.text, []).append(b.identifier)
    rader.extend('fragegrupp "%s": %s' % (text, ", ".join(identifierare))
                 for text, identifierare in grupper.items())
    skrivningar = skriv_placeringar(anropa, bedomningar) if skriv else []
    for s in skrivningar:
        if s.utfall == "andrad":
            rader.append("skrev %s: projekt %s" % (s.identifier, s.projekt))
        elif s.utfall == "oforandrad":
            rader.append("oforandrat %s: projektet var redan satt" % s.identifier)
        else:
            rader.append("FEL %s: update_issue gav %s" % (s.identifier, s.utfall[4:]))
    fel = sum(s.utfall.startswith("fel ") for s in skrivningar)
    if skriv:
        rader.append("KLAR: %d skrivna, %d oforandrade, %d fel" % (
            sum(s.utfall == "andrad" for s in skrivningar),
            sum(s.utfall == "oforandrad" for s in skrivningar), fel))
    else:
        rader.append("TORRKORNING: %d placeringar skrevs inte" %
                     sum(KODER.get(b.kod) == "placeras" for b in bedomningar))
    return Korning(UTFALL["SKRIVFEL"] if fel else UTFALL["KLAR"],
                   tuple(rader), tuple(bedomningar), tuple(skrivningar))


HOGAR = ("placeras", "fragegrupper", "utan_vag")
UTFALL = {"KLAR": 0, "SKRIVFEL": 1, "AVBRUTEN": 2}
ANROPSRAD = "FEL: anropet gar inte att tolka: [--skriv] [--regler <fil>]"


def hogar(bedomningar: list[Bedomning]) -> dict[str, list[Bedomning]]:
    resultat = {namn: [] for namn in HOGAR}
    for b in bedomningar:
        hog = KODER.get(b.kod)
        if hog in resultat:
            resultat[hog].append(b)
    return resultat


def kontrollera_summan(hogar: dict[str, list[Bedomning]], universum: list[Arende]) -> Optional[str]:
    identifierare = [b.identifier for namn in HOGAR for b in hogar[namn]]
    if sorted(identifierare) == sorted(a.identifier for a in universum):
        return None
    return "FEL: hogarna stammer inte med universum (summa %d, universum %d), inget skrevs" % (
        len(identifierare), len(universum))


def huvud(argument: list[str]) -> int:
    try:
        skriv = False
        regler = None
        index = 0
        while index < len(argument):
            flagga = argument[index]
            if flagga == "--skriv" and not skriv:
                skriv = True
            elif (flagga == "--regler" and regler is None and index + 1 < len(argument)
                  and argument[index + 1] and not argument[index + 1].startswith("--")):
                index += 1
                regler = argument[index]
            else:
                print(ANROPSRAD)
                return UTFALL["AVBRUTEN"]
            index += 1
        resultat = korning(arenden_klient.anropa, regler, skriv)
        for rad in resultat.rader:
            print(rad)
        return resultat.kod
    except Exception as fel:
        print("FEL: hemplaceringen stannade: %s" % type(fel).__name__)
        return UTFALL["AVBRUTEN"]


if __name__ == "__main__":
    sys.exit(huvud(sys.argv[1:]))
