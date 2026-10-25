#!/usr/bin/env python3
"""Nattsvitens forkontroller, korning och dom (FR-20, B-17 Nattsviten, Story 10.5).

Invarianter, numrerade for granskningen:
1. GRON nas bara i en provad form: kod 0, exakt en Tests-rad, och den raden
   matchar TESTSRAD, med bara ord ur ORDEN, varje ord hogst en gang, en summa
   som gar ihop, noll failed och minst en passed. doma provar i fast ordning,
   och GRON ar sista grenen.
2. En Tests-rad ar en rad vars forsta ord ar Tests, i vilken form som helst
   (TESTSMARKE, PRD FR-20:s kannetecken for att vitest startade). ROD nas bara
   nar utskriften har minst en Tests-rad, efter att startfel och avbrott
   provats, och da nar en Tests-rad eller en Test Files-rad (FILMARKE) har en
   del failed om minst 1, eller nar exitkoden ar skild fran 0. Exitkoden
   ensam, utan Tests-rad, ger aldrig ROD. Den provade formen (TESTSRAD) galler
   bara GRON.
3. Varje barnprocess kommer tillbaka. npm och larmet startas pa ett enda
   stalle, kor_barnprocess: utan ror (stdin mot DEVNULL, utskriften till en
   anonym tillfallig fil, larmets till DEVNULL) och i en egen session. Ett
   OSError vid starten ger KOD_STARTFEL. Vid tidsgransen far processgruppen
   SIGTERM, och SIGKILL kommer forst efter fristen. Tidsgransen och fristen har
   inga standardvarden dar, sa varje anrop anger sina.
4. Barnprocessens utskrift fors aldrig vidare. npm:s stdout och stderr gar till
   den anonyma filen och larmets till DEVNULL, sa ingen barnprocess arver
   nattsvitens stdout eller stderr. Varje utdatarad och larmets argument byggs
   bara av de fasta texterna och heltal.
5. Exitkoden kommer bara ur UTFALL: varje Dom har kod = UTFALL[utfall], och
   huvud ger bara dom.kod eller UTFALL["KUNDE_INTE"]. huvud fangar varje
   undantag och ger KUNDE_INTE, sa en krasch blir aldrig 1, som ar ROD.
6. forkontroll kors fore kor_npm och provar ocksa larmprogrammet, och ett skal
   darifran gor att npm aldrig startas. Larmet anropas pa ett enda stalle och
   bara vid ROD. Forkontrollen fragar samma testdatabas som sviten: varden och
   porten ur TEST_PG_HOST och TEST_PG_PORT i barnprocessens miljo, med
   standardvardena i test/env.ts rad 15-18, och --dbport fore TEST_PG_PORT.
   En variabel som bara star i repots .env (dotenv) laser forkontrollen inte;
   test/env.ts rad 6-9 lagger omvalet i TEST_*-variablerna, inte i .env.

Inforandet i nattskriptet i drift sker utanfor bygget.
"""

import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
from typing import NamedTuple

UTFALL = {"GRON": 0, "ROD": 1, "KUNDE_INTE": 2}
KOMMANDO = ("npm", "test")
# Sviten kors pa nagra minuter; granserna provas mot driftens kortid fore inforandet.
TIDSGRANS_S = 1800
FRIST_S = 10
DB_TIDSGRANS_S = 5
LARM_TIDSGRANS_S = 60
KOD_TIDSGRANS = 124  # Samma kod som timeout(1).
KOD_DODAD = 137  # Skalets kod for SIGKILL: 128 + 9.
KOD_STARTFEL = 127  # Skalets kod for ett kommando som saknas.
# Testdatabasens standardvarden, samma som i test/env.ts rad 15-18. De galler bara nar
# TEST_PG_HOST respektive TEST_PG_PORT saknas i miljon (databasadress).
DB_VARD = "127.0.0.1"
DB_PORT = 5436
PROC = "/proc"
VITESTNAMN = ("vitest", "vitest.mjs")
ORDEN = ("failed", "passed", "skipped", "todo")
# En Tests-rad ar en rad vars forsta ord ar Tests, i vilken form som helst. Det ar
# PRD FR-20:s kannetecken for att vitest startade (correct-course 2026-10-25, andra gangen).
TESTSMARKE = re.compile(r"^\s*Tests\b")
# Samma regel for raden Test Files.
FILMARKE = re.compile(r"^\s*Test Files\b")
# Vitests standardform for Tests-raden. Formen provas bara for GRON.
TESTSRAD = re.compile(r"^\s*Tests\s+(\d+ [a-z]+(?: \| \d+ [a-z]+)*) \((\d+)\)\s*$")
# En del: ett tal, ett blanksteg och ett ord.
DEL = re.compile(r"(\d+) ([a-z]+)")
SKAL = {
    "katalog": "katalogen saknas",
    "larm": "larmprogrammet gar inte att starta",
    "pagar": "en vitest-korning pagar redan",
    "databas": "testdatabasen svarar inte",
    "startfel": "npm test startade inte (kod %d)",
    "avbruten": "npm test avbrots innan sviten var klar (kod %d)",
    "ingen_rad": "ingen Tests-rad i utskriften (kod %d)",
    "flera_rader": "%d Tests-rader i utskriften (kod %d)",
    "form": "Tests-raden har en okand form (kod %d)",
    "noll": "inga prov korda (kod %d)",
}

GRONRAD = "GRON: nattsviten korde %d prov och inget fallerade"
RODRAD = "ROD: nattsviten fallerade (%d fallerade prov, %d fallerade provfiler, kod %d)"
KUNDE_INTE_RAD = "KUNDE_INTE: nattsviten kunde inte koras: %s"
LARMFEL = "LARM: larmet gick inte fram (kod %d)"
ANROPSRAD = ("KUNDE_INTE: anropet gar inte att tolka: --katalog <katalog> --larm <program> "
             "[--proc <katalog>] [--dbport <port>] [--tidsgrans <sekunder>]")
STANNADE = "KUNDE_INTE: nattsviten stannade: %s"
# De valfria namnen i anropet: parametern i kor_natt, och True for ett positivt heltal. Bara ett angivet
# namn fors vidare, sa varje standardvarde star pa ett enda stalle, i kor_natt.
VALFRIA = {
    "--proc": ("proc_katalog", False),
    "--dbport": ("dbport", True),
    "--tidsgrans": ("tidsgrans_s", True),
}


class Dom(NamedTuple):
    utfall: str
    kod: int
    rader: tuple[str, ...]


def kunde_inte(skal_text):
    return Dom("KUNDE_INTE", UTFALL["KUNDE_INTE"], (KUNDE_INTE_RAD % skal_text,))


def tests_rader(text):
    """Raderna vars forsta ord ar Tests; de lamnar aldrig modulen (invariant 2)."""
    return [rad for rad in text.splitlines() if TESTSMARKE.match(rad)]


def filrader(text):
    return [rad for rad in text.splitlines() if FILMARKE.match(rad)]


def fallerade(rader):
    """Summan av varje del <tal> failed, i vilken form raden an har."""
    return sum(int(delen.group(1)) for rad in rader for delen in DEL.finditer(rad)
               if delen.group(2) == "failed")


def tolka_rad(rad):
    """Ge (failed, passed, totalt) for en rad i den provade formen, annars None."""
    traff = TESTSRAD.match(rad)
    if traff is None:
        return None
    antal = {}
    for delen in traff.group(1).split(" | "):
        d = DEL.fullmatch(delen)
        if d is None or d.group(2) not in ORDEN or d.group(2) in antal:
            return None
        antal[d.group(2)] = int(d.group(1))
    totalt = int(traff.group(2))
    if sum(antal.values()) != totalt:
        return None
    return (antal.get("failed", 0), antal.get("passed", 0), totalt)


def doma(kod, text):
    """B-17 Domen efter npm test: slutna regler i fast ordning, GRON sist (invariant 1 och 2)."""
    if kod == KOD_STARTFEL:
        return kunde_inte(SKAL["startfel"] % kod)
    # En kod under 0 ar Popen:s kod for en barnprocess som dodats av en signal.
    if kod in (KOD_TIDSGRANS, KOD_DODAD) or kod < 0:
        return kunde_inte(SKAL["avbruten"] % kod)
    # Enda regeln som avgor om vitest startade.
    rader = tests_rader(text)
    if not rader:
        return kunde_inte(SKAL["ingen_rad"] % kod)
    f = fallerade(rader)
    ff = fallerade(filrader(text))
    if f >= 1 or ff >= 1:
        return Dom("ROD", UTFALL["ROD"], (RODRAD % (f, ff, kod),))
    # Vitest startade och domde sjalv korningen som fallerad.
    if kod != 0:
        return Dom("ROD", UTFALL["ROD"], (RODRAD % (0, 0, kod),))
    # Har nas bara kod 0 utan fallerade prov: den provade formen galler.
    if len(rader) > 1:
        return kunde_inte(SKAL["flera_rader"] % (len(rader), kod))
    tolkad = tolka_rad(rader[0])
    if tolkad is None:
        return kunde_inte(SKAL["form"] % kod)
    passed = tolkad[1]
    if passed == 0:
        return kunde_inte(SKAL["noll"] % kod)
    return Dom("GRON", UTFALL["GRON"], (GRONRAD % passed,))


def barnmiljo():
    """Vitests rader utan fargkoder, sa att de borjar med sina ord. Inget annat andras."""
    miljo = dict(os.environ)
    miljo.pop("FORCE_COLOR", None)
    miljo["NO_COLOR"] = "1"
    return miljo


def vanta(proc, tidsgrans_s, frist_s):
    """Ge processens kod, KOD_TIDSGRANS eller KOD_DODAD (invariant 3), som kor_git i spegelleverans."""
    try:
        return proc.wait(timeout=tidsgrans_s)
    except subprocess.TimeoutExpired:
        # SIGTERM forst, sa att npm och vitest hinner stada sina barn.
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=frist_s)
            return KOD_TIDSGRANS
        except subprocess.TimeoutExpired:
            # Bara ett program som inte avslutas pa SIGTERM behover SIGKILL.
            # Bada killpg sker innan wait skordat processen: id:t ar inte ateranvant.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            return KOD_DODAD


def kor_barnprocess(argv, ut, tidsgrans_s, frist_s, cwd=None, env=None):
    """Enda vagen till en barnprocess, for bade npm och larmet (invariant 3 och 4): stdout och stderr
    till ut, och samma start, startfel och tidsgrans for bada."""
    try:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=ut,
                                stderr=subprocess.STDOUT, start_new_session=True)
    except OSError:
        return KOD_STARTFEL
    return vanta(proc, tidsgrans_s, frist_s)


def kor_npm(katalog, tidsgrans_s=TIDSGRANS_S, frist_s=FRIST_S):
    """Ge (kod, text). KOMMANDO lases vid anropet."""
    # Ingen rorlasning: ett barnbarn som arver filen kan inte halla kvar vantan.
    with tempfile.TemporaryFile() as ut:
        kod = kor_barnprocess(list(KOMMANDO), ut, tidsgrans_s, frist_s, cwd=katalog, env=barnmiljo())
        ut.seek(0)
        return (kod, ut.read().decode("utf-8", errors="replace"))


def larmet_kan_startas(program):
    """Popen soker ett namn utan snedstreck i PATH men isfile laser det mot arbetskatalogen;
    med en absolut sokvag provar forkontrollen samma fil som kor_larm startar."""
    return os.path.isabs(program) and os.path.isfile(program) and os.access(program, os.X_OK)


def vitest_pagar(proc_katalog):
    """En process vars argument har ett sista sokvagsled exakt ur VITESTNAMN."""
    for namn in os.listdir(proc_katalog):
        if not namn.isdigit():
            continue
        try:
            with open(os.path.join(proc_katalog, namn, "cmdline"), "rb") as fil:
                data = fil.read()
        except (FileNotFoundError, ProcessLookupError):
            # Processen avslutades mellan listningen och lasningen.
            continue
        argv = [a.decode("utf-8", errors="replace") for a in data.split(b"\0")]
        if any(os.path.basename(a) in VITESTNAMN for a in argv):
            return True
    return False


def databasadress(miljo, dbport=None):
    """(vard, port) for testdatabasen som sviten ansluter till, eller None (invariant 6).

    Samma variabler och standardvarden som test/env.ts rad 15-18, och som ?? dar far bara en
    variabel som saknas sitt standardvarde. --dbport (provets port) gar fore TEST_PG_PORT. En tom
    vard, eller en port som inte ar ett tal utan inledande nolla mellan 1 och 65535, ar ingen
    adress som sviten kan na."""
    vard = miljo.get("TEST_PG_HOST", DB_VARD)
    port = miljo.get("TEST_PG_PORT", str(DB_PORT)) if dbport is None else str(dbport)
    if vard == "" or not re.fullmatch(r"[1-9][0-9]{0,4}", port) or int(port) > 65535:
        return None
    return (vard, int(port))


def databasen_svarar(vard, port, tidsgrans_s=DB_TIDSGRANS_S):
    try:
        with socket.create_connection((vard, port), timeout=tidsgrans_s):
            pass
    except OSError:
        return False
    return True


def forkontroll(katalog, larm, proc_katalog, dbport):
    """Ge en nyckel i SKAL eller None; slutna regler i fast ordning (invariant 6)."""
    if not os.path.isdir(katalog):
        return "katalog"
    if not larmet_kan_startas(larm):
        return "larm"
    if vitest_pagar(proc_katalog):
        return "pagar"
    # Samma miljo som npm far, sa att fragan gar till svitens testdatabas.
    adress = databasadress(barnmiljo(), dbport)
    if adress is None or not databasen_svarar(*adress):
        return "databas"
    return None


def kor_larm(program, rad, tidsgrans_s=LARM_TIDSGRANS_S):
    """Domens rad ar programmets enda argument, och dess utskrift gar till DEVNULL (invariant 4)."""
    return kor_barnprocess([program, rad], subprocess.DEVNULL, tidsgrans_s, FRIST_S)


def kor_natt(katalog, larm, proc_katalog=PROC, dbport=None, tidsgrans_s=TIDSGRANS_S):
    skal = forkontroll(katalog, larm, proc_katalog, dbport)
    if skal is not None:
        return kunde_inte(SKAL[skal])
    dom = doma(*kor_npm(katalog, tidsgrans_s))
    # Invariant 6: enda anropet av larmet, och bara vid ROD.
    if dom.utfall == "ROD":
        kod = kor_larm(larm, dom.rader[0])
        if kod != 0:
            return Dom("ROD", UTFALL["ROD"], dom.rader + (LARMFEL % kod,))
    return dom


def huvud(argument):
    """Hela kroppen, ocksa tolkningen av anropet, star i ett try (invariant 5)."""
    try:
        par = list(zip(argument[0::2], argument[1::2]))
        varden = dict(par)
        # Tillatelselistor: kanda namn, varje namn en gang och med ett varde, de tva kraven och
        # positiva heltal. Ett namn utan varde ar ett udda antal argument, ett tomt varde eller ett
        # varde som borjar med --, som i huvud i placeringslasning. str.isdigit() anvands inte,
        # eftersom den godtar siffror som int() inte tar.
        if (len(argument) % 2 != 0 or len(varden) != len(par)
                or not set(varden) <= {"--katalog", "--larm", *VALFRIA}
                or not {"--katalog", "--larm"} <= set(varden)
                or any(varde == "" or varde.startswith("--") for varde in varden.values())
                or not all(re.fullmatch(r"[0-9]+", varden[namn]) and int(varden[namn]) > 0
                           for namn, (_, heltal) in VALFRIA.items() if heltal and namn in varden)):
            print(ANROPSRAD)
            return UTFALL["KUNDE_INTE"]
        # Ett namn som saknas far sitt standardvarde i kor_natt; utan --dbport tar forkontrollen
        # porten ur TEST_PG_PORT, som sviten (databasadress).
        valfria = {parameter: int(varden[namn]) if heltal else varden[namn]
                   for namn, (parameter, heltal) in VALFRIA.items() if namn in varden}
        dom = kor_natt(varden["--katalog"], varden["--larm"], **valfria)
        for rad in dom.rader:
            print(rad)
        return dom.kod
    except Exception as fel:
        print(STANNADE % type(fel).__name__)
        return UTFALL["KUNDE_INTE"]


if __name__ == "__main__":
    sys.exit(huvud(sys.argv[1:]))
