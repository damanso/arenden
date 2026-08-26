#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Avstamningsprov for K-4: binder den kvarvarande hardkodade tabellen i
crm_ingest.py till det som FAKTISKT star i de tva databaserna.

Bakgrund: PROJEKT_TILL_ORG fanns i tva kopior pa tva sprak utan nagot prov som
band ihop dem. TS-kopian ar borttagen (arenden anvander nu projects.kund_id).
Python-kopian sitter kvar i en nattlig ingest som inte far tas ner i samma
andetag - darfor det har provet: den far finnas kvar, men den far inte glida
isar fran databasen utan att nagon far veta det.

Provet matter REGELN, inte en lista med kanda fel:

  R1  Varje 'kopplad' projekt pekar pa en kund som VERKLIGEN finns.
  R2  Varje rad i PROJEKT_TILL_ORG som ocksa finns som projekt i arenden pekar
      pa SAMMA kund som databaskopplingen gor.
  R3  Ett 'intern' eller 'oavgjord' projekt bar aldrig ett kund_id.
  R4  Inget projekt ar kopplat till en ARKIVERAD organisation utan kund - det
      var precis den fallan namnmatchningen gick i.

Utfall:  0 = GRON      alla regler haller
         1 = ROD       minst en regel bruten
         2 = KUNDE_INTE  provet kunde inte avgora saken (databas nere, fil borta)

KUNDE_INTE ar ett eget utfall med flit. Ett prov som inte kunde kora och som
rapporterar GRON ar precis den tysta logn det har provet finns for att fanga.
"""
from __future__ import annotations

import re
import subprocess
import sys

GRON, ROD, KUNDE_INTE = 0, 1, 2

INGEST = "/home/hermes/.hermes/skills/crm_ingest.py"
ARENDEN_CT = "arenden-postgres"
REDOV_CT = "redovisning-postgres"


class Ouppnaeligt(Exception):
    """Provet kunde inte hamta sitt underlag. Blir KUNDE_INTE, aldrig ROD."""


def fraga(container: str, db: str, sql: str) -> list[list[str]]:
    """Ren SQL mot en container. Rader som listor av falt."""
    try:
        p = subprocess.run(
            ["docker", "exec", container, "psql", "-U", "postgres", "-d", db,
             "-t", "-A", "-F", "\x1f", "-c", sql],
            capture_output=True, text=True, timeout=25,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Ouppnaeligt("%s: %s" % (container, e))
    # Returkoden ar det som betyder nagot har, men bara for ATT vi kunde fraga.
    if p.returncode != 0:
        raise Ouppnaeligt("%s: psql gav %d: %s" % (container, p.returncode, p.stderr.strip()[:200]))
    rader = []
    for rad in p.stdout.splitlines():
        if rad.strip() == "":
            continue
        rader.append(rad.split("\x1f"))
    return rader


def las_hardkodad_tabell(sokvag: str) -> dict[str, str]:
    """Plockar ut PROJEKT_TILL_ORG ur kallkoden utan att importera modulen.

    Import hade dragit in databaskopplingar och sidoeffekter; provet ska laesa
    tabellen, inte starta ingesten.
    """
    try:
        with open(sokvag, encoding="utf-8") as f:
            kod = f.read()
    except OSError as e:
        raise Ouppnaeligt("kunde inte lasa %s: %s" % (sokvag, e))
    m = re.search(r"PROJEKT_TILL_ORG\s*=\s*\{(.*?)\}", kod, re.S)
    if not m:
        raise Ouppnaeligt("PROJEKT_TILL_ORG hittades inte i %s" % sokvag)
    tabell = {}
    for nyckel, varde in re.findall(r'"([^"]+)"\s*:\s*"([^"]+)"', m.group(1)):
        tabell[nyckel] = varde
    if not tabell:
        raise Ouppnaeligt("PROJEKT_TILL_ORG ar tom eller oparsebar")
    return tabell


def kor() -> tuple[int, list[str], list[str]]:
    brott: list[str] = []
    noteringar: list[str] = []

    tabell = las_hardkodad_tabell(INGEST)

    projekt = {
        r[0]: {"kund_id": r[1] or None, "status": r[2], "kalla": r[3] or None}
        for r in fraga(ARENDEN_CT, "arenden",
                       "SELECT namn, coalesce(kund_id::text,''), koppling_status, "
                       "coalesce(kund_kalla,'') FROM projects")
    }
    kunder = {r[0]: r[1] for r in fraga(REDOV_CT, "redovisning",
                                        "SELECT id::text, name FROM customers")}
    orgar = {
        r[0]: {"kund_id": r[1] or None, "status": r[2]}
        for r in fraga(REDOV_CT, "redovisning",
                       "SELECT name, coalesce(customer_id::text,''), status FROM crm.organizations")
    }

    # R1 - kopplingen pekar pa nagot som finns.
    for namn, p in sorted(projekt.items()):
        if p["status"] == "kopplad":
            if p["kund_id"] not in kunder:
                brott.append("R1: projektet %s ar kopplat till kund_id %s som inte finns i "
                             "redovisningen" % (namn, p["kund_id"]))
            elif p["kalla"] != "redovisning":
                brott.append("R1: projektet %s har kund_id men kalla=%r" % (namn, p["kalla"]))

    # R3 - okopplade projekt bar inget id.
    for namn, p in sorted(projekt.items()):
        if p["status"] != "kopplad" and p["kund_id"] is not None:
            brott.append("R3: projektet %s har status %s men bar kund_id %s"
                         % (namn, p["status"], p["kund_id"]))

    # R2 - BINDNINGEN. Den hardkodade tabellen mot databasen.
    for pnamn, orgnamn in sorted(tabell.items()):
        p = projekt.get(pnamn)
        if p is None:
            noteringar.append("R2: %s star i PROJEKT_TILL_ORG men finns inte som projekt i "
                              "arenden - inget att stamma av" % pnamn)
            continue
        if p["status"] != "kopplad":
            noteringar.append("R2: %s star i PROJEKT_TILL_ORG (-> %s) men ar %s i arenden - "
                              "kraver Davids beslut" % (pnamn, orgnamn, p["status"]))
            continue
        kundnamn = kunder.get(p["kund_id"])
        # Tabellen sager ett ORGANISATIONSNAMN. Det far peka pa samma kund
        # antingen direkt (kundens namn) eller via CRM-organisationen.
        via_org = orgar.get(orgnamn, {}).get("kund_id")
        if kundnamn != orgnamn and via_org != p["kund_id"]:
            brott.append("R2: PROJEKT_TILL_ORG sager %s -> %r, men databasen kopplar %s till "
                         "kunden %r. Kopiorna har glidit isar."
                         % (pnamn, orgnamn, pnamn, kundnamn))

    # R4 - fallan. Ingen koppling till en arkiverad organisation utan kund.
    for orgnamn, o in sorted(orgar.items()):
        if o["status"] == "archived" and o["kund_id"] is None and orgnamn in projekt:
            p = projekt[orgnamn]
            if p["status"] == "kopplad":
                brott.append("R4: projektet %s ar kopplat trots att organisationen med samma "
                             "namn ar arkiverad utan kund" % orgnamn)
            else:
                noteringar.append("R4 ok: %s har en arkiverad, kundlos CRM-post med samma namn "
                                  "och ar %s i arenden - fallan undveks" % (orgnamn, p["status"]))

    return (ROD if brott else GRON), brott, noteringar


def main() -> int:
    negativ = "--negativ-kontroll" in sys.argv
    if negativ:
        # Bevisar att provet KAN falla: samma regler, men med en tabell som
        # medvetet pastar fel sak. Ger provet gront har ar provet trasigt.
        global las_hardkodad_tabell
        akta = las_hardkodad_tabell

        def trasig(_sokvag: str) -> dict[str, str]:
            t = akta(INGEST)
            t["NVR-001"] = "Synologen AB"   # fel kund, med flit
            return t

        las_hardkodad_tabell = trasig

    try:
        utfall, brott, noteringar = kor()
    except Ouppnaeligt as e:
        print("KUNDE_INTE: %s" % e)
        return KUNDE_INTE

    for n in noteringar:
        print("  not. %s" % n)
    for b in brott:
        print("  BROTT %s" % b)

    if negativ:
        if utfall == ROD:
            print("NEGATIV KONTROLL GRON: provet fallde den trasiga tabellen som det skulle")
            return GRON
        print("NEGATIV KONTROLL ROD: provet marker INTE en felaktig tabell - provet ar trasigt")
        return ROD

    print("GRON: kopplingarna haller" if utfall == GRON else "ROD: %d regelbrott" % len(brott))
    return utfall


if __name__ == "__main__":
    sys.exit(main())
