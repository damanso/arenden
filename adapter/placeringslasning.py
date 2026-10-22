#!/usr/bin/env python3
"""Placeringsprovets lasning och dom (FR-19, B-17 Tre utfall, Story 10.4).

Placeringsprovet i drift for in modulen utanfor bygget.

Invarianter:
1. All plattformslasning gar genom hamta_plattformen i ett enda try. Varje
   undantag ger fel med steget och felet, utan arenden eller register.
   API:t har ingen gemensam ogonblicksbild: ett hemlost arende bars av sin
   listrad och ett placerat bara av ett get_issue-svar vars handelser ar
   lika med foregaende svars. Handelser kan bara laggas till, och svarets
   rad lases mellan de tva handelselasningarna. Registret lases fore och
   efter arendena och maste ge samma namn; varje placerat arendes projekt
   maste sta i det (rename_project byter namn utan handelse pa arendet).
   Annars AndradesUnderLasningen. Placeringen ar andrade_projekt med storst
   heltals-id, aldrig den sista i listan: listan foljer transaktionens
   starttid, medan id foljer radlasets ordning.
2. En hemplacering (gallande placering med PREFIX i skalet) harleds om med
   hemplacering.bedom_arende ur arendets egna falt. Bara en placerande
   bedomning med samma projekt och exakt samma skal ar harledd. Varje
   korning provar ocksa att en pahittad placering fangas.
3. doma provar lasfel, regelfil, inga arenden, motprov, sparren och
   omharledningen i fast ordning. GRON kravs hel lasning, fangat motprov,
   inga hemlosa efter sparren och varje hemplacering harledd. De hemlosa
   fran fore sparren raknas men domer aldrig.
4. Exitkoden kommer bara ur UTFALL. huvud fangar varje undantag och ger
   KUNDE_INTE, sa en krasch blir aldrig 1, som ar ROD.
"""

import sys
from typing import NamedTuple, Optional

import arenden_klient
import hemplacering

SIDSTORLEK = 100
SIDTAK = 1000
# Tva lika handelselistor i foljd kravs; tre lasningar tal en skrivning mitt i lasningen.
DETALJTAK = 3


class AndradesUnderLasningen(Exception):
    """Plattformen gick inte att lasa i en version (FR-19)."""


class Rad(NamedTuple):
    arende: hemplacering.Arende
    projekt: Optional[str]
    placering: Optional[tuple[Optional[str], Optional[str]]]


class Lasning(NamedTuple):
    fel: Optional[str]
    arenden: tuple[Rad, ...]
    register: frozenset[str]


def beskriv(fel) -> str:
    return ("%s %s" % (fel.status, fel.kod)
            if hasattr(fel, "status") and hasattr(fel, "kod") else type(fel).__name__)


def nummer(rad: Rad) -> tuple[str, int]:
    prefix, tal = rad.arende.identifier.rsplit("-", 1)
    return prefix, int(tal)


def till_rad(rad, handelser) -> Rad:
    projekt = rad["projekt"]
    if projekt is not None and not isinstance(projekt, str):
        raise ValueError("projektets namn ar inte en strang")
    arende = hemplacering.till_arende(rad, handelser)
    placering = None
    if handelser is not None:
        # listaHandelser ordnar efter tidpunkt,id; tidpunkt ar transaktionens
        # starttid (0004). id tas vid skrivningen efter radlaset (arenden.ts:590),
        # sa bara storsta heltals-id ger bytet som faktiskt fick verkan sist.
        byten = [h for h in handelser if h["verb"] == "andrade_projekt"]
        if byten:
            payload = max(byten, key=lambda h: int(h["id"]))["payload"]
            placering = (payload.get("till"), payload.get("skal"))
    return Rad(arende, projekt, placering)


def hamta_detalj(anropa, identifier):
    forra = anropa("get_issue", {"identifier": identifier})
    for _ in range(DETALJTAK - 1):
        svar = anropa("get_issue", {"identifier": identifier})
        # Det senare svarets rad lases mellan de lika handelselistorna.
        # Append-only (0004) och registry.ts:287-292 ger en faktisk version.
        if svar["handelser"] == forra["handelser"]:
            return svar["arende"], svar["handelser"]
        forra = svar
    raise AndradesUnderLasningen()


def hamta_plattformen(anropa) -> Lasning:
    steg = "list_issues"
    try:
        rader = []
        indata = {"limit": SIDSTORLEK}
        for sida in range(SIDTAK):
            steg = "list_issues"
            svar = anropa("list_issues", indata)
            if sida == 0:
                steg = "list_project_customers"
                register = hemplacering.las_projekt(anropa)
            for rad in svar["arenden"]:
                if rad["projekt"] is None:
                    rader.append(till_rad(rad, None))
                else:
                    steg = "get_issue " + rad["identifier"]
                    arende, handelser = hamta_detalj(anropa, rad["identifier"])
                    last = till_rad(arende, handelser)
                    # Namnbyten saknar handelse pa arendet. Dess projekt maste
                    # darfor ocksa finnas i registrets forsta lasning (regel 3).
                    if last.projekt is not None and last.projekt not in register:
                        raise AndradesUnderLasningen()
                    rader.append(last)
            if not svar["pageInfo"]["har_nasta"]:
                break
            indata = {"limit": SIDSTORLEK, "cursor": svar["pageInfo"]["slut_cursor"]}
        else:
            raise RuntimeError("sidtaket overskreds")
        steg = "list_project_customers"
        if hemplacering.las_projekt(anropa) != register:
            raise AndradesUnderLasningen()
        return Lasning(None, tuple(sorted(rader, key=nummer)), register)
    except Exception as fel:
        return Lasning("%s (%s)" % (steg, beskriv(fel)), (), frozenset())


# Hemplaceringens skalform (hemplacering.py:219). Andra projektbyten, t.ex.
# Davids, har ingen harledning ur bevis att prova.
PREFIX = "hemplacering: "
UTFALL = {"GRON": 0, "ROD": 1, "KUNDE_INTE": 2}
MOTPROVRAD = "motprov: den pahittade placeringen fangades"


class Dom(NamedTuple):
    utfall: str
    kod: int
    rader: tuple[str, ...]


def ar_hemplacering(rad: Rad) -> bool:
    return (rad.projekt is not None and rad.placering is not None
            and isinstance(rad.placering[1], str) and rad.placering[1].startswith(PREFIX))


def harled_om(rad: Rad, register: frozenset[str], regelutfall: hemplacering.Regelutfall) -> Optional[str]:
    b = hemplacering.bedom_arende(rad.arende, register, regelutfall)
    till, skal = rad.placering
    if (hemplacering.KODER.get(b.kod) == "placeras"
            and b.projekt == till == rad.projekt and b.text == skal):
        return None
    return 'ej harledd %s: projekt %s, skal "%s", omharledning %s: %s' % (
        rad.arende.identifier, rad.projekt, skal, b.kod, b.text)


def motprov(register: frozenset[str]) -> Rad:
    projekt = sorted(register)[0] if register else "Motprov"
    arende = hemplacering.Arende("MOTPROV-0", "Motprov utan bevis", (), hemplacering.SPARR54_GRANS, None)
    return Rad(arende, projekt, (projekt, PREFIX + 'titeltagg "Motprov" ger %s (niva 1)' % projekt))


def doma(lasning: Lasning, regelutfall: hemplacering.Regelutfall, regelfil_angiven: bool) -> Dom:
    if lasning.fel is not None:
        return Dom("KUNDE_INTE", UTFALL["KUNDE_INTE"],
                   ("KUNDE_INTE: arendeplattformen gar inte att lasa: " + lasning.fel,))
    if regelfil_angiven and regelutfall.regler is None:
        return Dom("KUNDE_INTE", UTFALL["KUNDE_INTE"], ("KUNDE_INTE: " + regelutfall.orsak,))
    if not lasning.arenden:
        return Dom("KUNDE_INTE", UTFALL["KUNDE_INTE"], ("KUNDE_INTE: inga arenden lastes",))
    if harled_om(motprov(lasning.register), lasning.register, regelutfall) is None:
        return Dom("KUNDE_INTE", UTFALL["KUNDE_INTE"],
                   ("KUNDE_INTE: motprovet slapptes igenom, omharledningen fangar inte en pahittad placering",))
    efter = [r.arende.identifier for r in lasning.arenden
             if r.projekt is None and not hemplacering.fore_sparren(r.arende)]
    fore = sum(r.projekt is None and hemplacering.fore_sparren(r.arende) for r in lasning.arenden)
    placeringar = [r for r in lasning.arenden if ar_hemplacering(r)]
    ej = [text for r in placeringar
          if (text := harled_om(r, lasning.register, regelutfall)) is not None]
    sammanfattning = ("placeringar: arenden=%d hemplacerade=%d harledda=%d ej_harledda=%d "
                      "hemlosa_efter_sparren=%d hemlosa_fore_sparren=%d") % (
                          len(lasning.arenden), len(placeringar), len(placeringar) - len(ej),
                          len(ej), len(efter), fore)
    if efter or ej:
        return Dom("ROD", UTFALL["ROD"], tuple([
            "ROD: placeringarna haller inte", sammanfattning, MOTPROVRAD,
            *["LARM: hemlost efter sparren (sparr 0): " + identifier for identifier in efter],
            *["LARM: " + text for text in ej],
        ]))
    return Dom("GRON", UTFALL["GRON"],
               ("GRON: varje placering ar harledd om och sparren haller", sammanfattning, MOTPROVRAD))


ANROPSRAD = "KUNDE_INTE: anropet gar inte att tolka: [--regler <fil>]"


def huvud(argument: list[str]) -> int:
    try:
        regler = None
        if argument:
            if (len(argument) == 2 and argument[0] == "--regler" and argument[1]
                    and not argument[1].startswith("--")):
                regler = argument[1]
            else:
                print(ANROPSRAD)
                return UTFALL["KUNDE_INTE"]
        regelutfall = hemplacering.las_regler(regler)
        lasning = hamta_plattformen(arenden_klient.anropa)
        dom = doma(lasning, regelutfall, regler is not None)
        for rad in dom.rader:
            print(rad)
        return dom.kod
    except Exception as fel:
        print("KUNDE_INTE: placeringsprovet stannade: %s" % type(fel).__name__)
        return UTFALL["KUNDE_INTE"]


if __name__ == "__main__":
    sys.exit(huvud(sys.argv[1:]))
