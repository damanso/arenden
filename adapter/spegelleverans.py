"""Leveransen av arendespegeln till valvets git-repo (FR-18, B-17 Spegeln, Story 10.1).

Invarianter, numrerade for granskningen:
1. Git-tillstandet avgor leveransen, inte vad korningen skrev. leverera lagger
   alltid till allt okommittat under spegelkatalogen och pushar alltid, ocksa
   nar skriv_arende inte andrade nagot och filer eller commits ligger kvar.
2. Varje returkod lases. Forsta felet avbryter med steg och kod; inget senare
   steg kors. diff har tva lyckade utfall: 0 (oforandrat) och 1 (andrat).
3. Varje anrop kommer tillbaka utan ror eller terminal: wait har tidsgrans.
   SIGTERM pa processgruppen later git stada sina egna las och ger
   KOD_TIDSGRANS. Bara efter FRIST_S foljer SIGKILL och KOD_DODAD.
   Modulen tar aldrig sjalv bort en lasfil.
4. Bara spegelkatalogen levereras. kommando bygger alla argumentlistor och
   add, diff och commit bar alltid -- <katalog>. Ovriga filer, ocksa i index
   fran andra skrivare, lamnas som de ar. Modulen oppnar aldrig en spegelfil.
5. Gits utskrift lases aldrig: stdout och stderr gar till /dev/null. Leverans
   bar bara steg och kod, sa ingen fri text, fjarradress eller nyckel loggas.
6. Vattenmarket skrivs pa ett enda stalle i kor_spegling, bara efter lyckad leverans.
7. Spegelns sparr omsluter enda anropet av leverera, fran add till push, och
   slapps ocksa vid fel. Modulen har inget eget las.

Git-koraren kor kan bytas for provets attrapp och tidsgrans, men bar aldrig
nagot las. Inforandet i spegeln i drift sker utanfor bygget.
"""

import contextlib
import os
import signal
import subprocess
import sys
from typing import NamedTuple, Optional

STEG = ("add", "diff", "commit", "pull", "push")
# Cron 5,35: hogst 130 sekunder per anrop, fem steg hogst 11 minuter,
# sa ocksa en hangande korning blir klar fore nasta halvtimmeskorning.
TIDSGRANS_S = 120
FRIST_S = 10
KOD_TIDSGRANS = 124  # Samma kod som timeout(1).
KOD_DODAD = 137  # Skalets kod for SIGKILL: 128 + 9.
KOD_STARTFEL = 127  # Skalets kod for ett kommando som saknas.


class Leverans(NamedTuple):
    levererad: bool
    steg: Optional[str]
    kod: Optional[int]
    committade: bool


def kommando(steg, katalog, meddelande):
    """Sluten tillatelselista; index fran andra skrivare far inte folja med."""
    if steg == "add":
        return ["add", "-A", "--", katalog]
    if steg == "diff":
        return ["diff", "--cached", "--quiet", "--", katalog]
    if steg == "commit":
        return ["commit", "-q", "-m", meddelande, "--", katalog]
    if steg == "pull":
        return ["pull", "-q"]
    if steg == "push":
        return ["push", "-q"]
    raise ValueError("okant git-steg")


def kor_git(valv, argument, tidsgrans_s=TIDSGRANS_S, frist_s=FRIST_S):
    """Ge bara koden, ocksa nar git saknas eller aldrig svarar (FR-18)."""
    # Inga ror som ett barnbarn (ssh, upload-pack, krok) kan halla oppna:
    # enda vantan ar pa git. Egen session ger ingen styrande terminal for
    # losenordsfragor och en processgrupp som ocksa nar barnbarnen.
    try:
        proc = subprocess.Popen(
            ["git", "-C", str(valv)] + list(argument),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        return KOD_STARTFEL
    try:
        return proc.wait(timeout=tidsgrans_s)
    except subprocess.TimeoutExpired:
        # SIGTERM forst: git tar bort egna las, bland annat index.lock.
        # SIGKILL direkt lamnar dem kvar och stoppar aterleveransen (fynd 6).
        # Ta aldrig bort las har: de kan tillhora en annan skrivare (fynd 7).
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=frist_s)
            return KOD_TIDSGRANS
        except subprocess.TimeoutExpired:
            # Bara ett program som inte avslutas pa SIGTERM behover SIGKILL.
            # Signalen kan inte fangas, sa wait efter den kommer tillbaka.
            # Bada killpg sker innan wait skordat processen: id:t ar inte ateranvant.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            return KOD_DODAD


def leverera(valv, katalog, meddelande, kor=kor_git):
    """Leverera ocksa kvarliggande filer och commits, utan egen utskrift."""
    kod = kor(valv, kommando("add", katalog, meddelande))
    if kod != 0:
        return Leverans(False, "add", kod, False)
    kod = kor(valv, kommando("diff", katalog, meddelande))
    if kod not in (0, 1):
        return Leverans(False, "diff", kod, False)
    committade = kod == 1
    if committade:
        kod = kor(valv, kommando("commit", katalog, meddelande))
        if kod != 0:
            return Leverans(False, "commit", kod, False)
    for steg in ("pull", "push"):
        kod = kor(valv, kommando(steg, katalog, meddelande))
        if kod != 0:
            return Leverans(False, steg, kod, committade)
    return Leverans(True, None, None, committade)


def felrad(leverans):
    """Bara steget ur STEG och heltalskoden far na loggen (invariant 5)."""
    return "spegeln: leveransen misslyckades i git %s (kod %d); vattenmarket ar orort" % (leverans.steg, leverans.kod)


def kor_spegling(hamta_vattenmarke, spegla, skriv_vattenmarke, valv, katalog,
                 meddelande, kor=kor_git, sparr=contextlib.nullcontext, fel=None):
    """FR-18: leverera innan vattenmarket flyttas; larma med kod 1 vid fel."""
    sedan = hamta_vattenmarke()
    nytt = spegla(sedan)
    # Hela leveransen skyddas: ingen annan skrivare far komma in mellan add
    # och push. Ett las i kor hade slappts vid varje git-anrop (invariant 7).
    with sparr():
        leverans = leverera(valv, katalog, meddelande, kor)
    if not leverans.levererad:
        print(felrad(leverans), file=sys.stderr if fel is None else fel)
        return 1
    # FR-18, invariant 6: enda skrivningen. Fel eller undantag fore den lamnar
    # vattenmarket orort; laset halls inte langre an leveransen.
    skriv_vattenmarke(nytt)
    return 0
