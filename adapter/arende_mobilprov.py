#!/usr/bin/env python3
"""Mobilprovet (FR-15, B-16, B-17 Tre utfall, Story 10.9).

Oppnar ytan pa en testserver i en huvudlos webblasare vid telefonens och
iPadens bredd och provar att inget hamnar utanfor skarmen. Kors utan
argument under kanalens prov_prefix arende; inforandet som kopia sker
utanfor bygget (forkrav i drift), och provet i repot ar
test/mobilprov.test.ts.
Invarianter:
1. En enda vag in: konfigurationen lases bara av hamta_konfig, med ett try
   runt lasningen och formen. Ett fel ger KUNDE_INTE.
2. Bas ar alltid en testserver: http, 127.0.0.1, en port som inte ar
   driftens 3002, ingen sokvag. Webblasaren startas en gang per bredd, med
   en ny profil som tas bort i stang.
3. Varje sida mats med mata, och varje skript som laser geometri byggs av
   geometriskript: forleden VANTA_TYPSNITT, skriptets handling, vantan
   VANTA_ANIMATIONER och forst sist en lasning. Ingen bredd lases alltsa
   innan sidans typsnitt har laddats och dess animationer ar klara. Varje
   sidsteg slutar med mata, ocksa efter det som menyn och knapparna oppnat.
   En knapp eller menypanel som inte ritas godtas aldrig som inom fonstret.
   Matningen litas pa bara nar motprovet slog ut, varje typsnitt laddades
   och fonstret har bredden.
4. Provnyckeln fors aldrig till en utskriftsrad: den finns bara i
   Konfig.nyckel, i argumentet till skicka for inloggningen och i raden
   Authorization i hamta_handelser. Raderna byggs bara av konstanter,
   stegnamn, sokvagar ur ytan, tal och typnamn.
5. Domen provar fel forst, fynd sedan och GRON sist, och exitkoden kommer
   bara ur UTFALL.
6. huvud gor varje undantag till KUNDE_INTE, sa att en krasch aldrig blir 1.
"""
import base64
import fcntl
import json
import os
import re
import select
import shutil
import signal
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import NamedTuple, Optional

# Konfigurationen under hemmet; i drift skrivs den av forkravet, i kopian av provet.
KONFIGFIL = (".hermes", "arende_mobilprov.json")
NYCKLAR = ("arende", "bas", "nyckelfil", "webblasare")
VARD = "127.0.0.1"
DRIFTPORT = 3002
ARENDEFORM = re.compile(r"[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*")
PROGRAMFORM = re.compile(r"[a-z0-9._-]+|/\S+")
# Formens slutna tabell: bara dessa texter nar en rad, aldrig ett varde ur filen.
FORMFEL = ("fel nycklar", "bas ar ingen testserver", "arendet gar inte att tolka",
           "nyckelfilen ar inte en absolut sokvag", "nyckelfilen ar tom", "webblasaren gar inte att tolka")
TIDSGRANS = 20
STARTFLAGGOR = ("--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
                "--disable-gpu", "--disable-extensions", "--user-data-dir=%s", "about:blank")
# Telefonens bredd och hojd, och iPad minis staende (UX-specifikationen).
BREDDER = ((375, 812), (744, 1133))


class Konfig(NamedTuple):
    bas: str
    nyckel: str
    arende: str
    webblasare: str


class Konfiglage(NamedTuple):
    konfig: Optional[Konfig]
    fel: Optional[str]


class Kanalfel(RuntimeError):
    # Ett felsvar fran webblasaren; texten ar metodens namn.
    pass


def ar_testserver(bas):
    if not isinstance(bas, str):
        return False
    try:
        delar = urllib.parse.urlsplit(bas)
        port = delar.port
    except ValueError:
        return False
    return (delar.scheme == "http" and port is not None and port != DRIFTPORT
            and delar.netloc == "%s:%d" % (VARD, port)
            and delar.path == "" and delar.query == "" and delar.fragment == "")


def hamta_konfig(hem):
    try:
        with open(os.path.join(hem, *KONFIGFIL), "rb") as fil:
            data = json.loads(fil.read().decode("utf-8"))
        if not isinstance(data, dict) or sorted(data) != sorted(NYCKLAR):
            raise ValueError("fel nycklar")
        # Bas provas fore textkravet: ett bas som inte ar text ar ingen testserver.
        if not ar_testserver(data["bas"]):
            raise ValueError("bas ar ingen testserver")
        if not all(isinstance(data[namn], str) for namn in NYCKLAR):
            raise ValueError("fel nycklar")
        if not ARENDEFORM.fullmatch(data["arende"]):
            raise ValueError("arendet gar inte att tolka")
        if not os.path.isabs(data["nyckelfil"]):
            raise ValueError("nyckelfilen ar inte en absolut sokvag")
        with open(data["nyckelfil"], "rb") as fil:
            nyckel = fil.read().decode("utf-8").strip()
        if not nyckel:
            raise ValueError("nyckelfilen ar tom")
        if not PROGRAMFORM.fullmatch(data["webblasare"]):
            raise ValueError("webblasaren gar inte att tolka")
        return Konfiglage(Konfig(data["bas"], nyckel, data["arende"], data["webblasare"]), None)
    except Exception as fel:
        # JSONDecodeError och UnicodeDecodeError ar ocksa ValueError: de bar sin typ, inte sin text.
        if type(fel) is ValueError and str(fel) in FORMFEL:
            return Konfiglage(None, str(fel))
        return Konfiglage(None, type(fel).__name__)


def flyttad(fd):
    # Rorens andar flyttas till 10 och uppat, sa att ingen ligger pa barnets 3 eller 4.
    ny = fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 10)
    os.close(fd)
    return ny


class Kanal:
    """Chrome DevTools-protokollet over tva ror: webblasaren laser fd 3 och skriver fd 4."""

    def __init__(self):
        self.pid = None
        self.profil = None
        self.till_barnet = self.fran_barnet = self.barnets_in = self.barnets_ut = None
        self.buffert = b""
        self.handelser = []
        self.senaste_id = 0

    def oppna(self, program):
        self.profil = tempfile.mkdtemp(prefix="arende_mobilprov-")
        r, w = os.pipe()
        self.barnets_in, self.till_barnet = flyttad(r), flyttad(w)
        r, w = os.pipe()
        self.fran_barnet, self.barnets_ut = flyttad(r), flyttad(w)
        sokvag = program if "/" in program else shutil.which(program)
        if sokvag is None:
            raise FileNotFoundError("webblasaren finns inte i PATH")
        argv = [sokvag] + [flagga % self.profil if "%s" in flagga else flagga for flagga in STARTFLAGGOR]
        # Inte subprocess: pass_fds med preexec_fn ger EBADF for stangda 3 och 4, och
        # close_fds=False lagger Popens felrapport pa 3 och 4 (berattelsens Dev Notes).
        atgarder = [
            (os.POSIX_SPAWN_OPEN, 0, os.devnull, os.O_RDONLY, 0),
            (os.POSIX_SPAWN_OPEN, 1, os.devnull, os.O_WRONLY, 0),
            (os.POSIX_SPAWN_OPEN, 2, os.devnull, os.O_WRONLY, 0),
            (os.POSIX_SPAWN_DUP2, self.barnets_in, 3),
            (os.POSIX_SPAWN_DUP2, self.barnets_ut, 4),
        ]
        self.pid = os.posix_spawn(sokvag, argv, dict(os.environ), file_actions=atgarder,
                                  setpgroup=0, setsigdef=(signal.SIGPIPE,))
        os.close(self.barnets_in)
        os.close(self.barnets_ut)
        self.barnets_in = self.barnets_ut = None

    def skriv(self, meddelande):
        data = json.dumps(meddelande).encode("utf-8") + b"\0"
        try:
            while data:
                data = data[os.write(self.till_barnet, data):]
        except BrokenPipeError:
            # En webblasare som redan avslutat ger samma typ som ett stangt ror vid lasning.
            raise EOFError("roret till webblasaren ar stangt") from None

    def nasta(self, grans):
        while b"\0" not in self.buffert:
            kvar = grans - time.monotonic()
            if kvar <= 0 or not select.select([self.fran_barnet], [], [], kvar)[0]:
                raise TimeoutError("webblasaren svarade inte inom tidsgransen")
            bit = os.read(self.fran_barnet, 65536)
            if not bit:
                raise EOFError("roret fran webblasaren ar stangt")
            self.buffert += bit
        rad, self.buffert = self.buffert.split(b"\0", 1)
        return json.loads(rad.decode("utf-8"))

    def anropa(self, metod, params=None, session=None):
        self.senaste_id += 1
        nr = self.senaste_id
        meddelande = {"id": nr, "method": metod, "params": params or {}}
        if session is not None:
            meddelande["sessionId"] = session
        self.skriv(meddelande)
        grans = time.monotonic() + TIDSGRANS
        while True:
            svar = self.nasta(grans)
            if "id" not in svar:
                self.handelser.append(svar)
            elif svar["id"] == nr:
                if "error" in svar:
                    raise Kanalfel(metod)
                return svar.get("result", {})

    def handelser_sedan(self, start, namn, tidsgrans):
        grans = time.monotonic() + tidsgrans
        while True:
            for i in range(start, len(self.handelser)):
                if self.handelser[i].get("method") == namn:
                    return i
            meddelande = self.nasta(grans)
            if "id" not in meddelande:
                self.handelser.append(meddelande)

    def vantat_ut(self, sekunder):
        slut = time.monotonic() + sekunder
        while os.waitpid(self.pid, os.WNOHANG)[0] == 0:
            if time.monotonic() >= slut:
                return False
            time.sleep(0.05)
        return True

    def stang(self):
        # Kastar aldrig: efter stang finns ingen process, ingen zombie och ingen profil kvar.
        try:
            if self.pid is not None:
                try:
                    self.senaste_id += 1
                    self.skriv({"id": self.senaste_id, "method": "Browser.close", "params": {}})
                except Exception:
                    pass
                if not self.vantat_ut(5):
                    try:
                        os.killpg(self.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    os.waitpid(self.pid, 0)
        except Exception:
            pass
        finally:
            self.pid = None
            for fd in (self.till_barnet, self.fran_barnet, self.barnets_in, self.barnets_ut):
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
            self.till_barnet = self.fran_barnet = self.barnets_in = self.barnets_ut = None
            if self.profil is not None:
                shutil.rmtree(self.profil, ignore_errors=True)
                self.profil = None


def starta(konfig, bredd, hojd):
    kanal = Kanal()
    try:
        kanal.oppna(konfig.webblasare)
        mal = kanal.anropa("Target.createTarget", {"url": "about:blank"})
        session = kanal.anropa("Target.attachToTarget", {"targetId": mal["targetId"], "flatten": True})["sessionId"]
        kanal.anropa("Page.enable", {}, session)
        kanal.anropa("Network.enable", {}, session)
        kanal.anropa("Emulation.setDeviceMetricsOverride",
                     {"width": bredd, "height": hojd, "deviceScaleFactor": 2, "mobile": True}, session)
        return kanal, session
    except BaseException:
        kanal.stang()
        raise


# Chromium laser market som en kommentar; attrappen laser namnet och argumentet ur det.
MARKE = "/*arende_mobilprov:%s:%s*/"
# Ytans typsnitt har font-display:swap: forleden laddar varje anmalt typsnitt, ocksa
# ett som bara en oppnad meny behover, och vantar tills inget laddas langre.
VANTA_TYPSNITT = ("await Promise.all(Array.from(document.fonts, function (f) { "
                  "return f.load().catch(function () { return null; }); })); await document.fonts.ready; ")
# Geometrin ar slutlig forst nar animationerna ar klara: menyns panel reser sig i 170 ms efter klicket
# (navrise i src/http/vy/mall.ts), och det som en oppnad details eller en laddad sida satter i rorelse har
# annars inte natt sitt slutlage. En avbruten animation paverkar inte langre geometrin. En som aldrig tar
# slut nar TIDSGRANS och steget stannar: en geometri som aldrig blir slutlig ar KUNDE_INTE, aldrig GRON.
VANTA_ANIMATIONER = ("await Promise.all(document.getAnimations().map(function (a) { "
                     "return a.finished.catch(function () { return null; }); })); ")
# Kanterna for ett element som ritas. Ett som inte ritas (display:none, dolt, genomskinligt, eller utan
# bredd eller hojd) har inga kanter, [0, 0], och fyndreglerna godtar aldrig det som inom fonstret.
KANTER = ("function kanter(e) { var r = e.getBoundingClientRect(); "
          "return e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width > 0 "
          "&& r.height > 0 ? [Math.round(r.left), Math.round(r.right)] : [0, 0]; } ")


def geometriskript(kropp, handling=""):
    # Enda sattet ett skript som laser geometri byggs pa: typsnitten forst, sedan skriptets handling (ett
    # klick eller en oppnad details), sedan vantan pa animationerna, och forst darefter nagon lasning.
    return "async function (arg) { " + VANTA_TYPSNITT + handling + VANTA_ANIMATIONER + KANTER + kropp + " }"


SKRIPT = {
    "matning": geometriskript(
        "var d = document.documentElement; "
        "return { dokument: d.scrollWidth, fonster: d.clientWidth, "
        "kvitto: document.querySelector('p.notis.kvitto') !== null, "
        "formular: Array.from(document.forms, function (f) { return f.getAttribute('action'); }), "
        "typsnitt: Array.from(document.fonts).filter(function (f) { return f.status !== 'loaded'; }).length };"),
    "meny": geometriskript(
        handling=("var m = document.querySelector('details.navmenu'); "
                  "var s = m === null ? null : m.querySelector(':scope > summary'); "
                  "if (s === null) { return { oppen: false, vanster: 0, hoger: 0 }; } "
                  "s.click(); "),
        kropp=("var p = m.querySelector('.navmenu__panel'); "
               "var k = p === null ? [0, 0] : kanter(p); "
               "return { oppen: m.open === true, vanster: k[0], hoger: k[1] };")),
    # Varje details runt knappen oppnas, inte bara rattelserna: en knapp i en stangd details mats aldrig.
    "knappar": geometriskript(
        handling=("function knapp(a) { "
                  "var f = Array.from(document.forms).find(function (x) { return x.getAttribute('action') === a; }); "
                  "return f === undefined ? undefined : "
                  "Array.from(f.elements).find(function (e) { return e.type === 'submit'; }); } "
                  "Array.from(document.querySelectorAll('details.rattelse'), function (d) { d.open = true; }); "
                  "arg.forEach(function (a) { var k = knapp(a); "
                  "for (var d = k === undefined ? null : k.closest('details'); d !== null; "
                  "d = d.parentElement === null ? null : d.parentElement.closest('details')) { d.open = true; } }); "),
        kropp=("var ut = {}; "
               "arg.forEach(function (a) { var k = knapp(a); ut[a] = k === undefined ? null : kanter(k); }); "
               "return ut;")),
    # Laser ingen geometri och har darfor ingen forled.
    "skicka": (
        "function (arg) { "
        "var f = Array.from(document.forms).find(function (x) { return x.getAttribute('action') === arg.adress; }); "
        "if (f === undefined) { return { skickat: false }; } "
        "var d = f.closest('details'); if (d !== null) { d.open = true; } "
        "var namn = Object.keys(arg.falt); "
        "for (var i = 0; i < namn.length; i++) { var e = f.elements.namedItem(namn[i]); "
        "if (e === null) { return { skickat: false }; } e.value = arg.falt[namn[i]]; } "
        "var k = Array.from(f.elements).find(function (x) { return x.type === 'submit'; }); "
        "if (k === undefined) { return { skickat: false }; } "
        "f.requestSubmit(k); return { skickat: true }; }"),
}

# AK 2:s fixtursida i modulen: motprovet mats forst i varje bredd och maste fallas.
FIXTURSIDA = ("<!doctype html><html><head><meta charset=utf-8>"
              "<meta name=viewport content='width=device-width,initial-scale=1'><title>Motprov</title></head>"
              "<body><div style=\"width:800px;height:10px\"></div></body></html>")
MOTPROV = "data:text/html;base64," + base64.b64encode(FIXTURSIDA.encode("utf-8")).decode("ascii")


class Sidlage(NamedTuple):
    ok: bool
    status: Optional[int]
    fel: Optional[str]


class Matning(NamedTuple):
    dokument: int
    fonster: int
    kvitto: bool
    formular: tuple
    typsnitt: int


class Meny(NamedTuple):
    oppen: bool
    vanster: int
    hoger: int


def sokvag_och_fraga(url):
    # Raderna bar adressens sokvag och fraga, aldrig bas-adressen.
    delar = urllib.parse.urlsplit(url)
    return delar.path + ("?" + delar.query if delar.query else "")


def utvardera(kanal, session, namn, arg):
    text = json.dumps(arg)
    uttryck = (MARKE % (namn, base64.b64encode(text.encode("utf-8")).decode("ascii"))
               + "(" + SKRIPT[namn] + ")(" + text + ")")
    svar = kanal.anropa("Runtime.evaluate", {"expression": uttryck, "returnByValue": True, "awaitPromise": True},
                        session)
    if "exceptionDetails" in svar:
        raise Kanalfel("Runtime.evaluate")
    return svar.get("result", {}).get("value")


def navigera(kanal, session, url, med_status):
    start = len(kanal.handelser)
    svar = kanal.anropa("Page.navigate", {"url": url}, session)
    if svar.get("errorText"):
        return Sidlage(False, None, "sidan nas inte: %s (%s)" % (sokvag_och_fraga(url), svar["errorText"]))
    kanal.handelser_sedan(start, "Page.loadEventFired", TIDSGRANS)
    status = None
    for handelse in kanal.handelser[start:]:
        params = handelse.get("params", {})
        if handelse.get("method") == "Network.responseReceived" and params.get("type") == "Document":
            status = params["response"]["status"]
    if med_status and status != 200:
        return Sidlage(False, status, "sidan nas inte: %s (status %s)" % (sokvag_och_fraga(url), status))
    return Sidlage(True, status, None)


def mata(kanal, session, bredd):
    # Ger alltid paret: matningen och felet, i fast ordning typsnitten fore fonstret.
    v = utvardera(kanal, session, "matning", None)
    matning = Matning(v["dokument"], v["fonster"], v["kvitto"], tuple(v["formular"]), v["typsnitt"])
    if matning.typsnitt > 0:
        return matning, "%d typsnitt laddades inte" % matning.typsnitt
    if matning.fonster != bredd:
        return matning, "fonstret fick inte bredden %d" % bredd
    return matning, None


def oppna_meny(kanal, session):
    v = utvardera(kanal, session, "meny", None)
    return Meny(v["oppen"] is True, v["vanster"], v["hoger"])


def knappar(kanal, session, adresser):
    v = utvardera(kanal, session, "knappar", list(adresser))
    return {a: None if v.get(a) is None else tuple(v[a]) for a in adresser}


class Skicklage(NamedTuple):
    skickat: bool
    status: Optional[int]
    plats: Optional[str]
    kvitto: bool
    formular: tuple
    matt: Optional[tuple]


class Handelselage(NamedTuple):
    rader: tuple
    fel: Optional[str]


def skicka(kanal, session, adress, falt, bredd):
    start = len(kanal.handelser)
    v = utvardera(kanal, session, "skicka", {"adress": adress, "falt": falt})
    if not (isinstance(v, dict) and v.get("skickat") is True):
        # Ingen sida har visats efter skrivningen: inget att mata, och inget dokumentfynd.
        return Skicklage(False, None, None, False, (), None)
    kanal.handelser_sedan(start, "Page.loadEventFired", TIDSGRANS)
    status = plats = None
    for handelse in kanal.handelser[start:]:
        params = handelse.get("params", {})
        if handelse.get("method") == "Network.requestWillBeSent" and "redirectResponse" in params:
            status = params["redirectResponse"]["status"]
            plats = sokvag_och_fraga(params["request"]["url"])
            break
    if status is None:
        for handelse in kanal.handelser[start:]:
            params = handelse.get("params", {})
            if handelse.get("method") == "Network.responseReceived" and params.get("type") == "Document":
                status = params["response"]["status"]
    matt = mata(kanal, session, bredd)
    return Skicklage(True, status, plats, matt[0].kvitto, matt[0].formular, matt)


def hamta_handelser(bas, nyckel, arende):
    # Ett enda POST till API:t, utan proxy. Klienten importeras inte: provet i drift
    # ligger i en annan katalog an skills-kopian av den.
    try:
        begaran = urllib.request.Request(
            bas + "/api/actions/get_issue", data=json.dumps({"identifier": arende}).encode("utf-8"),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + nyckel}, method="POST")
        oppnare = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with oppnare.open(begaran, timeout=TIDSGRANS) as svar:
            data = json.loads(svar.read().decode("utf-8"))
        # events.id ar bigint och kommer som text: heltal, annars ordnas "10" fore "9".
        rader = tuple((int(h["id"]), h["verb"], h["aktor_typ"]) for h in data["result"]["handelser"])
        return Handelselage(rader, None)
    except Exception as fel:
        return Handelselage((), type(fel).__name__)


def ny_handelse(fore, efter, verb):
    storsta = max((rad[0] for rad in fore), default=0)
    nya = [rad for rad in efter if rad[0] > storsta]
    if len(nya) != 1:
        return "gav %d nya handelser" % len(nya)
    if nya[0][1] != verb:
        return "handelsen har verbet %s" % nya[0][1]
    if nya[0][2] != "manniska":
        return "handelsen har aktoren %s" % nya[0][2]
    return None


UTFALL = {"GRON": 0, "ROD": 1, "KUNDE_INTE": 2}
GRON_RAD = "GRON: ytan haller sig inom fonstret i 375 och 744 px, och skrivningarna gav kvitto och handelserad"
ROD_RAD = "ROD: ytan gar utanfor fonstret eller ett formular fungerar inte i telefonens eller iPadens bredd"
KUNDE_INTE_RAD = "KUNDE_INTE: mobilprovet gar inte att genomfora"
FORSTA_RAD = {"GRON": GRON_RAD, "ROD": ROD_RAD, "KUNDE_INTE": KUNDE_INTE_RAD}
# AK 1:s sidor i fast ordning. Varje steg oppnar sin egen sida, sa inget steg beror pa var steget
# fore slutade; bara inloggningen bar sessionen till stegen efter.
SEKVENS = ("motprov", "laslage", "inloggningssidan", "inloggning", "oversikt", "mitt", "arendesidan",
           "kommentar", "titel")
ARENDEPREFIX = "/vy/arende/"
INLOGGNINGEN = "/vy/logga-in"
NEKAD = "/vy/logga-in?fel="


class Breddutfall(NamedTuple):
    bredd: int
    fynd: tuple
    fel: tuple
    rader: tuple


class Dom(NamedTuple):
    utfall: str
    kod: int
    rader: tuple


class Korning(NamedTuple):
    kanal: Kanal
    session: str
    konfig: Konfig
    bredd: int
    arende: str
    tid: str


class Stegutfall(NamedTuple):
    fynd: tuple
    fel: Optional[str]
    sida: bool
    skickat: bool


def dokumentfynd(matning):
    if matning.dokument > matning.fonster:
        return ("dokumentet ar %d px men fonstret %d px" % (matning.dokument, matning.fonster),)
    return ()


def ritad(kant):
    # Bara en kant med bredd ar ett element som ritas; ett som inte ritas har kanterna [0, 0] (KANTER).
    return kant is not None and kant[0] < kant[1]


def inom(kant, bredd):
    return 0 <= kant[0] and kant[1] <= bredd


def knappfynd(kanter, namngivna, bredd):
    # En tillatelselista: bara en knapp som ritas och ligger helt inom fonstret godtas. En knapp som inte
    # ritas saknas for den som anvander sidan.
    fynd = []
    for adress, namn in namngivna:
        kant = kanter.get(adress)
        if not ritad(kant):
            fynd.append("knappen i %s saknas" % namn)
        elif not inom(kant, bredd):
            fynd.append("knappen i %s hamnar utanfor fonstret" % namn)
    return tuple(fynd)


def menyfynd(meny, bredd):
    # Samma tillatelselista for panelen: en meny vars panel inte ritas gar inte att oppna.
    panel = (meny.vanster, meny.hoger)
    if not (meny.oppen and ritad(panel)):
        return ("menyn gar inte att oppna",)
    if not inom(panel, bredd):
        return ("menypanelen hamnar utanfor fonstret",)
    return ()


def steg_motprov(k):
    sida = navigera(k.kanal, k.session, MOTPROV, False)
    if not sida.ok:
        return Stegutfall((), sida.fel, False, False)
    matning, fel = mata(k.kanal, k.session, k.bredd)
    if fel is None and matning.dokument <= k.bredd:
        fel = "motprovet slog inte ut"
    return Stegutfall((), fel, False, False)


def sidsteg(k, sokvag, med_meny, namngivna):
    """En sida i ytan: matningen, menyn och knapparna, och sist en matning av sidan med det de oppnade."""
    sida = navigera(k.kanal, k.session, k.konfig.bas + sokvag, True)
    if not sida.ok:
        return Stegutfall((), sida.fel, False, False)
    forsta, fel = mata(k.kanal, k.session, k.bredd)
    if fel is not None:
        return Stegutfall((), fel, True, False)
    dokument, ovriga = dokumentfynd(forsta), ()
    if med_meny:
        ovriga += menyfynd(oppna_meny(k.kanal, k.session), k.bredd)
    if namngivna:
        kanter = knappar(k.kanal, k.session, [adress for adress, _ in namngivna])
        ovriga += knappfynd(kanter, namngivna, k.bredd)
    # Varje sidsteg slutar med mata: menyn och knapparna oppnar delar av sidan, som ocksa ska rymmas.
    # Hogst ett dokumentfynd per steg: den andra matningen ger det bara nar den forsta inte gav det.
    andra, fel = mata(k.kanal, k.session, k.bredd)
    if not dokument and fel is None:
        dokument = dokumentfynd(andra)
    return Stegutfall(dokument + ovriga, fel, True, False)


def skrivsteg(k, namn, sokvag, adress, falt, plats, verb):
    """En skrivning genom ytans formular; verb ar None for inloggningen, som inte skriver nagon handelserad."""
    # Skrivningen oppnar sin egen sida, som varje sidsteg: ett fynd i steget fore, som en kommentar
    # som landade pa en annan sida, far aldrig falla nasta skrivning.
    sida = navigera(k.kanal, k.session, k.konfig.bas + sokvag, True)
    if not sida.ok:
        return Stegutfall((), sida.fel, False, False)
    fore = None
    if verb is not None:
        fore = hamta_handelser(k.konfig.bas, k.konfig.nyckel, k.konfig.arende)
        if fore.fel is not None:
            return Stegutfall((), "handelserna gar inte att lasa: %s" % fore.fel, False, False)
    s = skicka(k.kanal, k.session, adress, falt, k.bredd)
    if not s.skickat:
        return Stegutfall(("%s gick inte att skicka" % namn,), None, False, False)
    if verb is None and s.status == 303 and (s.plats or "").startswith(NEKAD):
        # En nyckel som ytan inte godtar ar provets underlag, aldrig ett fynd om ytan.
        return Stegutfall((), "provnyckeln godtogs inte", True, True)
    matning, fel = s.matt
    # Hogst ett skal, det forsta som slar ut i tabellens ordning.
    skal = None
    if s.status != 303:
        skal = "gav inte 303"
    elif s.plats != plats:
        skal = "landade pa %s" % s.plats
    elif not s.kvitto:
        skal = "gav inget kvitto"
    elif verb is None:
        if k.arende + "/kommentar" not in s.formular:
            skal = "gav ingen session"
    else:
        efter = hamta_handelser(k.konfig.bas, k.konfig.nyckel, k.konfig.arende)
        if efter.fel is None:
            skal = ny_handelse(fore.rader, efter.rader, verb)
        elif fel is None:
            fel = "handelserna gar inte att lasa: %s" % efter.fel
    fynd = dokumentfynd(matning) if s.matt[1] is None else ()
    if skal is not None:
        fynd += ("%s %s" % (namn, skal),)
    return Stegutfall(fynd, fel, True, True)


def inloggningssida(k):
    return INLOGGNINGEN + "?fran=" + urllib.parse.quote(k.arende, safe="")


STEGEN = {
    "motprov": steg_motprov,
    "laslage": lambda k: sidsteg(k, k.arende, True, ()),
    "inloggningssidan": lambda k: sidsteg(k, inloggningssida(k), False, ((INLOGGNINGEN, "inloggningen"),)),
    "inloggning": lambda k: skrivsteg(k, "inloggningen", inloggningssida(k), INLOGGNINGEN,
                                      {"nyckel": k.konfig.nyckel}, k.arende + "?notis=inloggad", None),
    "oversikt": lambda k: sidsteg(k, "/vy", True, ()),
    "mitt": lambda k: sidsteg(k, "/vy/mitt", True, ()),
    "arendesidan": lambda k: sidsteg(k, k.arende, True, (
        (k.arende + "/kommentar", "kommentaren"),
        (k.arende + "/ratta", "rattelsen"),
        (k.arende + "/ratta?handgrepp=tillstand", "tillstandet"),
    )),
    "kommentar": lambda k: skrivsteg(k, "kommentaren", k.arende, k.arende + "/kommentar",
                                     {"body": "Mobilprovet %d px %s" % (k.bredd, k.tid)},
                                     k.arende + "?notis=kommenterad", "kommenterade"),
    "titel": lambda k: skrivsteg(k, "titeln", k.arende, k.arende + "/ratta",
                                 {"titel": "M109 mobilprovet %d px %s" % (k.bredd, k.tid)},
                                 k.arende + "?notis=arendet_rattat", "andrade_titel"),
}


def kor_bredd(konfig, bredd, hojd, tid):
    fynd, fel, rader = [], [], []
    sidor = skrivningar = 0
    kanal = session = startfel = None
    try:
        kanal, session = starta(konfig, bredd, hojd)
    except Kanalfel as undantag:
        startfel = "webblasaren svarade med fel pa %s" % undantag
    except Exception as undantag:
        startfel = "webblasaren startar inte: %s" % type(undantag).__name__
    avbrott = None
    if startfel is not None:
        fel.append(("start", startfel))
        rader.append("FEL: bredd %d start: %s" % (bredd, startfel))
        avbrott = "fel"
    try:
        for steg in SEKVENS:
            if avbrott is not None:
                rader.append("bredd %d %s: provades inte efter %s" % (bredd, steg, avbrott))
                continue
            try:
                u = STEGEN[steg](Korning(kanal, session, konfig, bredd, ARENDEPREFIX + konfig.arende, tid))
            except Exception as undantag:
                # Det enda natet: ett undantag ur kanalen i ett steg stoppar bredden som ett fel.
                u = Stegutfall((), "steget stannade: %s" % type(undantag).__name__, False, False)
            for text in u.fynd:
                fynd.append((steg, text))
                rader.append("FYND: bredd %d %s: %s" % (bredd, steg, text))
            if u.fel is not None:
                fel.append((steg, u.fel))
                rader.append("FEL: bredd %d %s: %s" % (bredd, steg, u.fel))
            if u.sida and steg != "motprov":
                sidor += 1
            if u.skickat:
                skrivningar += 1
            if u.fel is not None:
                avbrott = "fel"
            elif u.fynd and steg == "inloggning":
                avbrott = "fynd"
    finally:
        if kanal is not None:
            kanal.stang()
    summa = "bredd %d: sidor=%d skrivningar=%d fynd=%d" % (bredd, sidor, skrivningar, len(fynd))
    return Breddutfall(bredd, tuple(fynd), tuple(fel), (summa,) + tuple(rader))


def doma(konfigfel, utfall):
    rader = []
    if konfigfel is not None:
        rader.append("FEL: konfigurationen: %s" % konfigfel)
    elif not utfall:
        rader.append("FEL: inga bredder provades")
    for bredd in utfall:
        rader.extend(bredd.rader)
    if konfigfel is not None or any(bredd.fel for bredd in utfall):
        dom = "KUNDE_INTE"
    elif not utfall:
        dom = "KUNDE_INTE"
    elif any(bredd.fynd for bredd in utfall):
        dom = "ROD"
    else:
        dom = "GRON"
    return Dom(dom, UTFALL[dom], (FORSTA_RAD[dom],) + tuple(rader))


def kor(hem):
    lage = hamta_konfig(hem)
    if lage.fel is not None:
        return doma(lage.fel, ())
    # En tid per korning, med mikrosekunder: varje titel ar ny, ocksa nar korningar mot samma
    # provarende foljer inom en sekund. Annars landar rattelsen pa notis=oforandrad.
    ns = time.time_ns()
    tid = time.strftime("%Y-%m-%d %H.%M.%S", time.localtime(ns // 10**9)) + "." + "%06d" % (ns // 1000 % 10**6)
    return doma(None, tuple(kor_bredd(lage.konfig, bredd, hojd, tid) for bredd, hojd in BREDDER))


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
        print("KUNDE_INTE: mobilprovet stannade: %s" % type(fel).__name__)
        return UTFALL["KUNDE_INTE"]


if __name__ == "__main__":
    sys.exit(huvud(sys.argv[1:]))
