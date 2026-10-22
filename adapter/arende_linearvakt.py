#!/usr/bin/env python3
"""Linear-aterfallsvakten (FR-33, NFR-11, ADR-0003, B-17, Story 10.8).

Kors utan argument under kanalens prov_prefix arende; inforandet sker utanfor bygget.
Invarianter:
1. Crontab lases bara genom las_crontab. kor_crontab ar enda processtarten:
   exakt CRONTAB med TIDSGRANS. Undantag ger ingen text och sin typ.
2. Raderna har en sluten grammatik: MILJO, ORDFORM, operatorerna, cd forst,
   OMSLAG, TOLKAR med TOLKFLAGGOR och ratt andelse, eller PROGRAM.
   Varje plats har en klass eller ar data (berattelsens tabell Platserna).
   Lasfilen efter flock -n ar absolut. Allt annat ger ValueError, aldrig en
   gissning som kan ge GRON for kod som inte lases.
3. Varje anvandning (sokvag, slag, via) lases genom las_text och tolkas utan
   att koras. Python-skript ligger direkt i skills. Andra importformer ger
   ValueError. Olasbara filer bar sin typ; varje api.linear.app-rad raknas.
4. Klienten laddas och anropas i tva steg inne i fangat_nat. Fangarna
   antecknar, anropar aldrig originalen och kastar alltid Fangat; finally
   aterstaller originalen. Provad: laddning utan fel/anrop, list_issues
   slutar med Fangat efter exakt ett anrop. Annars ett skal. Bara PLATTFORMEN godtas.
5. doma provar olasbart underlag/oprovad klient, inga skript, traff/fel adress
   i den ordningen, GRON sist. Exitkoden kommer bara ur UTFALL.
6. huvud laser ingenting innan anropet tolkats; varje undantag ger KUNDE_INTE.
"""
import ast
import contextlib
import importlib.machinery
import os
import re
import socket
import subprocess
import sys
import types
import urllib.parse
import urllib.request
from typing import NamedTuple, Optional

# Enda processtarten listar bara anvandarens crontab.
CRONTAB = ("crontab", "-l")
TIDSGRANS = 10
SCHEMAORD = {"@reboot", "@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly"}
TIDSFALT = re.compile(r"[0-9A-Za-z*/,\-]+")
MILJORAD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*[ \t]*=")
# Tillatelselistorna ar hela grammatiken, plats for plats (tabellen Platserna).
# Allt annat ger ValueError; nya former fors in genom correct-course.
MILJO = {"MAILTO", "SHELL", "PATH"}
SKAL = {"/bin/sh", "/bin/bash", "/bin/dash", "/usr/bin/sh", "/usr/bin/bash", "/usr/bin/dash"}
ORDFORM = re.compile(r"(?:(?:~|\$HOME|\$\{HOME\})(?=/|\Z))?[A-Za-z0-9/._,:+=@-]*")
TECKEN = re.compile(r"[ \t]*(2>&1|[0-9]?>>|[0-9]?>|<|&&|\||;|[^ \t&|;<>]+)")
SEPARATORER = ("&&", ";", "|")
OMDIRIGERING = re.compile(r"[0-9]?>>|[0-9]?>|<")
FEL_TILL_UT = "2>&1"
# Hermes skript ar Python och sh (FR-33).
TOLKAR = ((r"python[0-9.]*", ".py"), (r"sh|bash|dash", ".sh"))
# -I och -P tar bort skriptkatalogen ur sys.path; skalens -s laser stdin.
TOLKFLAGGOR = {".py": {"-u", "-B", "-O", "-OO", "-E", "-s", "-S"}, ".sh": {"-e", "-x"}}
# Dessa program kor inte argumenten som kod.
PROGRAM = {"true", "date", "echo", "touch", "curl", "logger", "mkdir"}
OMSLAG = {"timeout", "flock"}
VARAKTIGHET = re.compile(r"[0-9]+[smhd]?")
# flock laser flaggor till forsta ordet utan '-'. -x som lasfil hade flyttat
# tolkens roll till skriptets shebang. LASFIL och VARAKTIGHET stanger den platsen.
LASFIL = re.compile(r"(?:/|~/|\$HOME/|\$\{HOME\}/)[A-Za-z0-9/._,:+=@-]*")


class Crontablage(NamedTuple):
    text: Optional[str]
    fel: Optional[str]


class Kommando(NamedTuple):
    nr: int
    skript: tuple[str, ...]
    fel: Optional[str]


def kor_crontab():
    return subprocess.run(list(CRONTAB), stdin=subprocess.DEVNULL, capture_output=True,
                          timeout=TIDSGRANS, check=True).stdout.decode("utf-8")


def las_crontab(lasare):
    try:
        text = lasare()
        if not isinstance(text, str):
            raise TypeError("crontab ar ingen text")
        return Crontablage(text, None)
    except Exception as fel:
        return Crontablage(None, type(fel).__name__)


def miljorad(s, hem):
    # Miljon galler efterfoljande kommandon: okanda namn kan kora olast kod.
    namn, varde = (del_.strip(" \t") for del_ in s.split("=", 1))
    if len(varde) >= 2 and varde[0] in ("'", '"') and varde[-1] == varde[0]:
        varde = varde[1:-1]
    if namn not in MILJO:
        raise ValueError("miljonamn")
    if namn == "SHELL" and varde not in SKAL:
        raise ValueError("skal")
    if namn == "PATH":
        for del_ in varde.split(":"):
            if (not del_.startswith("/") or ".." in del_.split("/")
                    or under_hemmet(os.path.normpath(del_), hem)):
                raise ValueError("sokvagens katalog")
    # Cron ger MAILTO till postprogrammet; ett '-' forst kan bli en flagga.
    if namn == "MAILTO" and varde and (not ORDFORM.fullmatch(varde) or varde.startswith("-")):
        raise ValueError("postmottagare")


def kommandodel(rad, hem):
    s = rad.strip(" \t")
    if not s or s.startswith("#"):
        return None
    if MILJORAD.match(s):
        miljorad(s, hem)
        return None
    if s.startswith("@"):
        falt = re.split(r"[ \t]+", s, maxsplit=1)
        if len(falt) != 2 or falt[0] not in SCHEMAORD:
            raise ValueError("schemaord")
        return falt[1]
    falt = re.split(r"[ \t]+", s, maxsplit=5)
    if len(falt) != 6 or not all(TIDSFALT.fullmatch(f) for f in falt[:5]):
        raise ValueError("tidsfalt")
    return falt[5]


def utvidga(ord, hem):
    for prefix in ("~", "$HOME", "${HOME}"):
        if ord == prefix:
            return hem
        if ord.startswith(prefix + "/"):
            return os.path.join(hem, ord[len(prefix) + 1:])
    if ord.startswith("~") or "$" in ord:
        raise ValueError("hemord")
    return ord


def under_hemmet(sokvag, hem):
    rot = os.path.normpath(hem)
    return sokvag == rot or sokvag.startswith(rot + os.sep)


def sokvag(ord, katalog, hem):
    m = utvidga(ord, hem)
    # '..' efter en symlank kan losas olika av skalet och normpath.
    if ".." in m.split("/"):
        raise ValueError("foralderkatalog")
    if os.path.isabs(m):
        return os.path.normpath(m)
    if katalog is None:
        raise ValueError("okand arbetskatalog")
    return os.path.normpath(os.path.join(katalog, m))


def programnamn(ord, hem):
    if "/" not in ord:
        return ord
    m = utvidga(ord, hem)
    if os.path.isabs(m) and ".." not in m.split("/") and not under_hemmet(os.path.normpath(m), hem):
        return os.path.basename(m)
    return None


def tolkens_andelse(namn):
    return next((andelse for form, andelse in TOLKAR if re.fullmatch(form, namn)), None)


def ar_operator(t):
    return t in SEPARATORER or t == FEL_TILL_UT or OMDIRIGERING.fullmatch(t) is not None


def dela(text):
    text = text.strip(" \t")
    tecken, position = [], 0
    while position < len(text):
        match = TECKEN.match(text, position)
        if match is None:
            raise ValueError("tecken")
        t = match.group(1)
        if not ar_operator(t) and not ORDFORM.fullmatch(t):
            raise ValueError("ordform")
        tecken.append(t)
        position = match.end()
    return tecken


def enkla_kommandon(tecken):
    kommandon, separatorer, ord = [], [], []
    i = 0
    while i < len(tecken):
        t = tecken[i]
        if t in SEPARATORER:
            if not ord:
                raise ValueError("tomt kommando")
            kommandon.append(ord)
            separatorer.append(t)
            ord = []
        elif t == FEL_TILL_UT:
            pass
        elif OMDIRIGERING.fullmatch(t):
            i += 1
            if i == len(tecken) or ar_operator(tecken[i]):
                raise ValueError("omdirigeringsmal")
        else:
            ord.append(t)
        i += 1
    if not ord:
        raise ValueError("tomt kommando")
    return kommandon + [ord], separatorer


def skript_i_kommando(kommando, hem, i_crontab):
    kommandon, separatorer = enkla_kommandon(dela(kommando))
    katalog, skript = hem if i_crontab else None, []
    for i, w in enumerate(kommandon):
        if w[0] == "cd":
            if (i != 0 or len(w) > 2 or (separatorer and separatorer[0] != "&&")
                    or any(s not in ("&&", "|") for s in separatorer)):
                raise ValueError("cds plats")
            if len(w) == 2 and w[1].startswith("-"):
                raise ValueError("cds mal")
            katalog = hem if len(w) == 1 else sokvag(w[1], katalog, hem)
            continue
        j = 0
        while j < len(w) and programnamn(w[j], hem) in OMSLAG:
            if programnamn(w[j], hem) == "timeout":
                if j + 1 >= len(w) or not VARAKTIGHET.fullmatch(w[j + 1]):
                    raise ValueError("varaktighet")
                j += 2
            else:
                if j + 2 >= len(w) or w[j + 1] != "-n" or not LASFIL.fullmatch(w[j + 2]):
                    raise ValueError("lasfil")
                j += 3
        if j == len(w):
            raise ValueError("omslutet kommando saknas")
        namn = programnamn(w[j], hem)
        andelse = tolkens_andelse(namn) if namn is not None else None
        if andelse is not None:
            j += 1
            while j < len(w) and w[j].startswith("-"):
                if w[j] not in TOLKFLAGGOR[andelse]:
                    raise ValueError("tolkflagga")
                j += 1
            if j == len(w) or not w[j].endswith(andelse):
                raise ValueError("tolkens skript")
            fil = sokvag(w[j], katalog, hem)
            if fil not in skript:
                skript.append(fil)
        elif namn not in PROGRAM:
            raise ValueError("forsta ordet")
    return tuple(skript)


def tolka_kommandon(text, hem):
    kommandon = []
    for nr, rad in enumerate(text.split("\n"), 1):
        try:
            kommando = kommandodel(rad, hem)
            if kommando is not None:
                kommandon.append(Kommando(nr, skript_i_kommando(kommando, hem, True), None))
        except Exception as fel:
            kommandon.append(Kommando(nr, (), type(fel).__name__))
    return tuple(kommandon)


# FR-33:s cutovermatning och B-17: varje rad med den har texten ar ett aterfall.
LINEAR = "api.linear.app"


class Skillslage(NamedTuple):
    moduler: Optional[tuple[str, ...]]
    paket: Optional[tuple[str, ...]]
    fel: Optional[str]


class Fil(NamedTuple):
    sokvag: str
    slag: str
    via: str
    traffar: Optional[tuple[int, ...]]
    fel: Optional[str]


def las_text(sokvag):
    with open(sokvag, "rb") as fil:
        return fil.read().decode("utf-8")


def las_skills(skills):
    try:
        moduler, paket = set(), set()
        andelser = [a for a in importlib.machinery.all_suffixes() if a != ".py"]
        with os.scandir(skills) as poster:
            for post in poster:
                namn = post.name
                if namn.isidentifier() and post.is_dir():
                    paket.add(namn)
                if post.is_file():
                    if namn.endswith(".py") and namn[:-3].isidentifier():
                        moduler.add(namn[:-3])
                    # Prova varje andelse: tung.abi3.so utan bara .so ar inget Python-namn.
                    for andelse in andelser:
                        if namn.endswith(andelse) and namn[:-len(andelse)].isidentifier():
                            paket.add(namn[:-len(andelse)])
                    # Versionstolkar kan ladda andra .so-andelser an vaktens egen tolk.
                    if namn.endswith(".so") and namn.split(".", 1)[0].isidentifier():
                        paket.add(namn.split(".", 1)[0])
        return Skillslage(tuple(sorted(moduler)), tuple(sorted(paket)), None)
    except Exception as fel:
        return Skillslage(None, None, type(fel).__name__)


def importer(text, sokvag):
    namn = set()
    for nod in ast.walk(ast.parse(text, filename=sokvag)):
        if isinstance(nod, ast.Import):
            namn.update(alias.name.split(".", 1)[0] for alias in nod.names)
        elif isinstance(nod, ast.ImportFrom) and nod.level == 0 and nod.module:
            namn.add(nod.module.split(".", 1)[0])
    return tuple(sorted(namn))


def traffar(text):
    return tuple(nr for nr, rad in enumerate(text.split("\n"), 1) if LINEAR in rad.casefold())


def skript_i_skal(text, hem):
    skript = []
    for rad in text.split("\n"):
        s = rad.strip(" \t")
        if s and not s.startswith("#"):
            for fil in skript_i_kommando(s, hem, False):
                if fil not in skript:
                    skript.append(fil)
    return tuple(skript)


def samla_filer(kommandon, skillslage, skills, hem):
    ko, sedda, filer = [], set(), []

    def lagg_till(sokvag, slag, via):
        # Slaget avgor reglerna, via avgor proveniensen: hela anvandningen ar nyckeln.
        post = (sokvag, slag, via)
        if post not in sedda:
            sedda.add(post)
            ko.append(post)

    for kommando in kommandon:
        for sokvag in kommando.skript:
            lagg_till(sokvag, "skript", sokvag)
    for sokvag, slag, via in ko:
        rader = None
        try:
            text = las_text(sokvag)
            rader = traffar(text)
            namn, skript = (), ()
            if sokvag.endswith(".py"):
                # Python soker skriptets importer i dess verkliga katalog, aven efter lankar.
                if slag == "skript" and os.path.dirname(os.path.realpath(sokvag)) != os.path.realpath(skills):
                    raise ValueError("skriptets katalog")
                namn = importer(text, sokvag)
                if skillslage.paket is not None and any(n in skillslage.paket for n in namn):
                    raise ValueError("annan importform")
            elif sokvag.endswith(".sh"):
                skript = skript_i_skal(text, hem)
        except Exception as fel:
            filer.append(Fil(sokvag, slag, via, rader, type(fel).__name__))
            continue
        filer.append(Fil(sokvag, slag, via, rader, None))
        if skillslage.moduler is not None:
            for n in namn:
                if n in skillslage.moduler:
                    lagg_till(os.path.join(skills, n + ".py"), "modul", via)
        for fil in skript:
            lagg_till(fil, "skript", via)
    return tuple(filer)


KLIENTFIL = "arenden_klient.py"
ATTRAPP = "linearvaktens-attrapp"
# Projektkontextens fasta appadress (loopback), enda tillatna adressen.
PLATTFORMEN = (("http", "127.0.0.1", 3002),)


class Fangat(BaseException):
    # ADR-0001: klientens retry och except Exception far aldrig svalja fangsten.
    pass


class Anrop(NamedTuple):
    vag: str
    schema: Optional[str]
    varden: Optional[str]
    port: Optional[int]
    sokvag: Optional[str]


class Utovning(NamedTuple):
    anrop: tuple[Anrop, ...]
    fel: Optional[str]


def text_eller_inget(v):
    return v if isinstance(v, str) else None


def heltal(v):
    if isinstance(v, int) and not isinstance(v, bool):
        return v
    if isinstance(v, str) and re.fullmatch(r"[0-9]+", v):
        return int(v)
    return None


@contextlib.contextmanager
def fangat_nat(anrop):
    original = (urllib.request.urlopen, socket.create_connection, socket.getaddrinfo, socket.socket)

    def urlopen(url, *argument, **nyckelord):
        a = Anrop("urlopen", None, None, None, None)
        try:
            adress = url.full_url if isinstance(url, urllib.request.Request) else url
            if isinstance(adress, str):
                delar = urllib.parse.urlsplit(adress)
                a = Anrop("urlopen", delar.scheme or None, delar.hostname, delar.port, delar.path or None)
        except Exception:
            pass
        anrop.append(a)
        raise Fangat()

    def create_connection(adress, *argument, **nyckelord):
        if isinstance(adress, tuple) and len(adress) >= 2:
            a = Anrop("create_connection", None, text_eller_inget(adress[0]), heltal(adress[1]), None)
        else:
            a = Anrop("create_connection", None, None, None, None)
        anrop.append(a)
        raise Fangat()

    def getaddrinfo(varden, port, *argument, **nyckelord):
        anrop.append(Anrop("getaddrinfo", None, text_eller_inget(varden), heltal(port), None))
        raise Fangat()

    def sockel(*argument, **nyckelord):
        anrop.append(Anrop("socket", None, None, None, None))
        raise Fangat()

    try:
        urllib.request.urlopen = urlopen
        socket.create_connection = create_connection
        socket.getaddrinfo = getaddrinfo
        socket.socket = sockel
        yield
    finally:
        urllib.request.urlopen, socket.create_connection, socket.getaddrinfo, socket.socket = original


def ladda_klienten(sokvag):
    kod = compile(las_text(sokvag), sokvag, "exec")
    modul = types.ModuleType("arenden_klient")
    modul.__file__ = sokvag
    exec(kod, modul.__dict__)
    return modul


def utova_klienten(sokvag):
    anrop, fel = [], None
    # SystemExit fran klienten far inte bli vaktens exitkod. Bada stegen har
    # egna try: en laddningsfangst ar aldrig en provning av list_issues.
    try:
        with fangat_nat(anrop):
            try:
                modul = ladda_klienten(sokvag)
            except BaseException as undantag:
                fel = type(undantag).__name__
            if anrop:
                fel = "laddningen gjorde ett anrop"
            if fel is None:
                try:
                    modul.list_issues(nyckel=ATTRAPP)
                except Fangat:
                    if len(anrop) == 1:
                        fel = None
                    elif len(anrop) > 1:
                        fel = "fler an ett anrop fangades"
                    else:
                        fel = "Fangat"
                except BaseException as undantag:
                    fel = type(undantag).__name__
                else:
                    fel = "list_issues gav ett svar"
    except BaseException as undantag:
        fel = type(undantag).__name__
    return Utovning(tuple(anrop), fel)


def anrop_status(a):
    if a.varden is None:
        return "adressen gar inte att avgora"
    if any(a.varden == varden and a.port == port
           and (a.schema == schema or (a.schema is None and a.vag != "urlopen"))
           for schema, varden, port in PLATTFORMEN):
        return "ok"
    return "inte plattformen"


UTFALL = {"GRON": 0, "ROD": 1, "KUNDE_INTE": 2}
GRONRAD = "GRON: inga cron-korda skript eller moduler innehaller api.linear.app, och klientens anrop gar till plattformen"
RODRAD = "ROD: aterfall mot Linear eller ett anrop som inte gar till plattformen"
KUNDE_INTE_RAD = "KUNDE_INTE: delar av linearvakten gar inte att prova"


class Dom(NamedTuple):
    utfall: str
    kod: int
    rader: tuple[str, ...]


def visa(v):
    return "-" if v is None else str(v)


def doma(crontab, kommandon, skillslage, filer, utovning):
    skript = sum(f.slag == "skript" for f in filer)
    moduler = sum(f.slag == "modul" for f in filer)
    olasta = sum(f.fel is not None for f in filer)
    crontraffar = traffar(crontab.text) if crontab.fel is None else ()
    antal_traffar = len(crontraffar) + sum(len(f.traffar or ()) for f in filer)
    statusar = tuple(anrop_status(a) for a in utovning.anrop)
    provad = utovning.fel is None and "adressen gar inte att avgora" not in statusar
    if (crontab.fel is not None or any(c.fel is not None for c in kommandon)
            or skillslage.fel is not None or olasta or not provad):
        utfall, forsta = "KUNDE_INTE", KUNDE_INTE_RAD
    elif skript == 0:
        utfall, forsta = "KUNDE_INTE", KUNDE_INTE_RAD
    elif antal_traffar or "inte plattformen" in statusar:
        utfall, forsta = "ROD", RODRAD
    else:
        utfall, forsta = "GRON", GRONRAD
    rader = [forsta, "underlag: kommandon=%d skript=%d moduler=%d olasta=%d traffar=%d" % (
        len(kommandon), skript, moduler, olasta, antal_traffar,
    )]
    if crontab.fel is not None:
        rader.append("crontab gar inte att lasa (%s)" % crontab.fel)
    if crontab.fel is None and skript == 0:
        rader.append("inga cron-korda skript att lasa")
    for c in kommandon:
        if c.fel is not None:
            rader.append("crontab rad %d gar inte att tolka (%s)" % (c.nr, c.fel))
        elif not c.skript:
            rader.append("crontab rad %d har inget skript" % c.nr)
    if skillslage.fel is not None:
        rader.append("skills gar inte att lasa (%s)" % skillslage.fel)
    for f in filer:
        if f.fel is not None:
            rader.append("%s %s gar inte att lasa (%s)" % (f.slag, f.sokvag, f.fel))
    for nr in crontraffar:
        rader.append("api.linear.app i crontab rad %d" % nr)
    for f in filer:
        for nr in f.traffar or ():
            rader.append("api.linear.app i %s %s rad %d (cron-skript %s)" % (f.slag, f.sokvag, nr, f.via))
    if utovning.fel is not None:
        rader.append("klienten gar inte att prova (%s)" % utovning.fel)
    for a, status in zip(utovning.anrop, statusar):
        rader.append("klientens anrop via %s: schema=%s varden=%s port=%s sokvag=%s, %s" % (
            *(visa(v) for v in a), status,
        ))
    return Dom(utfall, UTFALL[utfall], tuple(rader))


def kor(hem):
    skills = os.path.join(hem, ".hermes", "skills")
    crontab = las_crontab(kor_crontab)
    kommandon = tolka_kommandon(crontab.text, hem) if crontab.fel is None else ()
    skillslage = las_skills(skills)
    filer = samla_filer(kommandon, skillslage, skills, hem)
    utovning = utova_klienten(os.path.join(skills, KLIENTFIL))
    return doma(crontab, kommandon, skillslage, filer, utovning)


ANROPSRAD = "KUNDE_INTE: anropet gar inte att tolka: provet tar inga argument"


def huvud(argument):
    try:
        if argument:
            print(ANROPSRAD)
            return UTFALL["KUNDE_INTE"]
        dom = kor(os.path.expanduser("~"))
        for rad in dom.rader:
            print(rad)
        return dom.kod
    except Exception as fel:
        print("KUNDE_INTE: provet stannade: %s" % type(fel).__name__)
        return UTFALL["KUNDE_INTE"]


if __name__ == "__main__":
    sys.exit(huvud(sys.argv[1:]))
