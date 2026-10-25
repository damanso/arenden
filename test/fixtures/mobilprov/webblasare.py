#!/usr/bin/env python3
"""Webblasarattrappen for mobilprovet (FR-15, B-16, Story 10.9).

Provets webblasare i test/mobilprov.test.ts, i stallet for Chromium. Den talar
samma protokoll (Chrome DevTools) over samma ror som Chromium med
--remote-debugging-pipe: meddelanden som JSON med ett NUL-tecken efter, in pa
fd 3 och ut pa fd 4. Hamtningarna, kakorna och formularen ar riktiga mot
testservern, men attrappen gor ingen layout: dokumentets bredd ar den storsta
inline-bredden (width:Npx i ett style-attribut) pa sidan eller fonstrets, och
fonstrets bredd ar den emulerade. Den riktiga layouten mats i Chromium i
drift, och modulens motprov faller en webblasare som inte mater.

Styrs av miljon: ATTRAPP_LAGE ar ett eller flera lagen forenade med +, vart
och ett eventuellt med @ och en adress (sokvag med fraga), ATTRAPP_LOGG ar
loggens sokvag, en JSON-rad per post, och ATTRAPP_PLATS (standard /vy) ar
adressen som annan_plats och skicka_inte rapporterar. Bara standardbiblioteket.
"""
import base64
import html.parser
import http.cookiejar
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

# Utan flaggorna ar attrappen inget Chromium med ror, och den avslutar med 9.
FLAGGOR = ("--headless=new", "--remote-debugging-pipe")
PROFILFLAGGA = "--user-data-dir="
IN, UT = 3, 4
TIDSGRANS = 20
RAM = "attrapp-ram"
MARKE = re.compile(r"/\*arende_mobilprov:([a-z]+):([A-Za-z0-9+/=]*)\*/")
# Layoutregeln laser bara style-attribut; stilmallen bar till exempel max-width:640px.
INLINEBREDD = re.compile(r"(?<![-\w])width\s*:\s*([0-9]+)px")
KOMMENTAR = re.compile(r"/\*.*?\*/", re.S)
TYPSNITTSREGEL = re.compile(r"@font-face\s*\{([^}]*)\}")
KALLA = re.compile(r"url\(\s*[\"']?([^\"')]+)[\"']?\s*\)")
OMDIRIGERINGAR = (301, 302, 303, 307)


def tolka_lagen(text):
    lagen = []
    for del_ in text.split("+"):
        namn, _, adress = del_.partition("@")
        lagen.append((namn, adress or None))
    return tuple(lagen)


LAGEN = tolka_lagen(os.environ.get("ATTRAPP_LAGE", "normal"))
LOGG = os.environ.get("ATTRAPP_LOGG")
PLATS = os.environ.get("ATTRAPP_PLATS", "/vy")
# oppnad: menyn eller knapparna har oppnat delar av sidan sedan den laddades.
TILLSTAND = {"bredd": 0, "hojd": 0, "url": "about:blank", "text": "", "tolkning": None, "oppnad": False}
KAKOR = http.cookiejar.CookieJar()


def galler(namn, adress=None):
    # Ett lage utan adress galler overallt, ett med adress bara dar adressen ar exakt lika.
    return any(n == namn and (a is None or a == adress) for n, a in LAGEN)


def logga(post):
    if LOGG:
        with open(LOGG, "a", encoding="utf-8") as fil:
            fil.write(json.dumps(post) + "\n")


def skriv(meddelande):
    data = json.dumps(meddelande).encode("utf-8") + b"\0"
    while data:
        data = data[os.write(UT, data):]


def meddelanden():
    buffert = b""
    while True:
        bit = os.read(IN, 65536)
        if not bit:
            return
        buffert += bit
        while b"\0" in buffert:
            rad, buffert = buffert.split(b"\0", 1)
            yield json.loads(rad.decode("utf-8"))


def skriptnamn(params):
    # Loggen far bara skriptets namn ur market, aldrig argumentet: for inloggningen ar det provnyckeln.
    traff = MARKE.match(params.get("expression", ""))
    return None if traff is None else traff.group(1)


def skapa_mal(params):
    return {"targetId": "attrapp-mal"}, []


def koppla(params):
    return {"sessionId": "attrapp-session"}, []


def aktivera(params):
    return {}, []


def emulera(params):
    TILLSTAND["bredd"], TILLSTAND["hojd"] = params["width"], params["height"]
    return {}, []


# ---- Sidorna ----------------------------------------------------------------


class Tolkning(html.parser.HTMLParser):
    """Det attrappen behover ur en sida: inline-bredderna, stilmallarna, menyn och formularen."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.inline = []
        self.stilar = []
        self.navmeny = False
        self.formular = []
        self.form = None
        self.i_stil = False
        self.textruta = None

    def handle_starttag(self, tag, attrs):
        a = {namn: ("" if varde is None else varde) for namn, varde in attrs}
        self.inline.extend(int(m.group(1)) for m in INLINEBREDD.finditer(a.get("style", "")))
        typ = a.get("type", "").lower()
        if tag == "style":
            self.i_stil = True
            self.stilar.append("")
        elif tag == "details" and "navmenu" in a.get("class", "").split():
            # Ytan skriver attributet utan citattecken: <details class=navmenu>.
            self.navmeny = True
        elif tag == "form":
            self.form = {"action": a.get("action"), "falt": [], "knapp": False}
            self.formular.append(self.form)
        elif self.form is None:
            return
        elif tag == "button" and typ in ("", "submit"):
            self.form["knapp"] = True
        elif tag == "input" and typ == "submit":
            self.form["knapp"] = True
        elif tag == "input" and "name" in a and typ not in ("button", "reset", "image", "file"):
            if typ not in ("radio", "checkbox") or "checked" in a:
                self.form["falt"].append([a["name"], a.get("value", "")])
        elif tag == "textarea" and "name" in a:
            self.textruta = [a["name"], []]

    def handle_endtag(self, tag):
        if tag == "style":
            self.i_stil = False
        elif tag == "textarea" and self.textruta is not None:
            namn, delar = self.textruta
            text = "".join(delar)
            self.form["falt"].append([namn, text[1:] if text.startswith("\n") else text])
            self.textruta = None
        elif tag == "form":
            self.form = None

    def handle_data(self, data):
        if self.i_stil:
            self.stilar[-1] += data
        if self.textruta is not None:
            self.textruta[1].append(data)


def oppnare(*extra):
    # utan_kaka galler overallt: kakburken sparar och skickar ingen kaka.
    hanterare = [urllib.request.ProxyHandler({})]
    if not galler("utan_kaka"):
        hanterare.append(urllib.request.HTTPCookieProcessor(KAKOR))
    return urllib.request.build_opener(*hanterare, *extra)


class IngenOmdirigering(urllib.request.HTTPRedirectHandler):
    # Ett formulars POST foljer inte omdirigeringen: 303 kommer som HTTPError med Location.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def hamta(begaran, *extra):
    """Ger (status, adress, kropp, Location). Ett HTTPError ar ett svar; ett URLError kastas vidare."""
    try:
        with oppnare(*extra).open(begaran, timeout=TIDSGRANS) as svar:
            return svar.status, svar.geturl(), svar.read(), None
    except urllib.error.HTTPError as fel:
        try:
            return fel.code, begaran.full_url, fel.read(), fel.headers.get("Location")
        finally:
            fel.close()


def ny_sida(url, kropp):
    TILLSTAND["url"], TILLSTAND["text"], TILLSTAND["tolkning"] = url, kropp.decode("utf-8", "replace"), None
    TILLSTAND["oppnad"] = False


def tolkning():
    if TILLSTAND["tolkning"] is None:
        t = Tolkning()
        t.feed(TILLSTAND["text"])
        t.close()
        TILLSTAND["tolkning"] = t
    return TILLSTAND["tolkning"]


def sidhandelser(url, status):
    return [("Network.responseReceived", {"type": "Document", "response": {"url": url, "status": status}}),
            ("Page.loadEventFired", {"timestamp": 0})]


def navigera(params):
    url = params.get("url", "")
    if url.startswith("data:"):
        huvud, _, data = url[len("data:"):].partition(",")
        kropp = base64.b64decode(data) if huvud.endswith(";base64") else urllib.parse.unquote_to_bytes(data)
        status, slut = 200, url
    else:
        try:
            status, slut, kropp, _ = hamta(urllib.request.Request(url))
        except urllib.error.URLError:
            # Som Chromium: svaret bar errorText, och inga handelser foljer.
            return {"frameId": RAM, "errorText": "net::ERR_CONNECTION_REFUSED"}, []
    ny_sida(slut, kropp)
    return {"frameId": RAM, "loaderId": "attrapp-laddning"}, sidhandelser(slut, status)


def sidadress():
    delar = urllib.parse.urlsplit(TILLSTAND["url"])
    return delar.path + ("?" + delar.query if delar.query else "")


def sidlage(namn):
    # Sidlagena jamfors med sidans sokvag och fraga.
    return galler(namn, sidadress())


def efter_oppning(namn):
    # Ett sidlage som galler forst nar menyn eller knapparna har oppnat delar av sidan, som en panel som
    # spiller utanfor: bara matningen efter dem ser det.
    return TILLSTAND["oppnad"] and sidlage(namn)


def ladda_typsnitt():
    # Det forleden VANTA_TYPSNITT gor i Chromium: varje @font-face-regel i sidans
    # style-element laddas med kakburken innan matning, meny eller knappar svarar.
    saknade = 0
    for stil in tolkning().stilar:
        for regel in TYPSNITTSREGEL.findall(KOMMENTAR.sub("", stil)):
            for kalla in KALLA.findall(regel):
                url = urllib.parse.urljoin(TILLSTAND["url"], kalla)
                try:
                    status = hamta(urllib.request.Request(url))[0]
                except urllib.error.URLError:
                    status = 0
                logga({"typsnitt": urllib.parse.urlsplit(url).path, "status": status})
                if status != 200:
                    saknade += 1
    return saknade + (1 if sidlage("typsnitt_saknas") else 0)


def varde(v):
    return {"result": {"type": "object", "value": v}}


def matning(arg):
    saknade = ladda_typsnitt()
    t, bredd = tolkning(), TILLSTAND["bredd"]
    if sidlage("smal"):
        dokument = bredd
    elif sidlage("bred") or efter_oppning("bred_efter_oppning"):
        dokument = 800
    else:
        dokument = max([bredd] + t.inline)
    fonster_fel = sidlage("fonster_fel") or efter_oppning("fonster_fel_efter_oppning")
    return varde({
        "dokument": dokument,
        "fonster": bredd - 1 if fonster_fel else bredd,
        "kvitto": 'class="notis kvitto"' in TILLSTAND["text"] and not sidlage("utan_kvitto"),
        "formular": [f["action"] for f in t.formular],
        "typsnitt": saknade,
    }), []


def meny(arg):
    ladda_typsnitt()
    TILLSTAND["oppnad"] = True
    bredd = TILLSTAND["bredd"]
    if not tolkning().navmeny or sidlage("meny_stangd"):
        return varde({"oppen": False, "vanster": 0, "hoger": 0}), []
    if sidlage("meny_dold"):
        # Menyn ar oppen men panelen ritas inte: inga kanter, som modulens KANTER ger.
        return varde({"oppen": True, "vanster": 0, "hoger": 0}), []
    return varde({"oppen": True, "vanster": 8, "hoger": bredd + 40 if sidlage("meny_utanfor") else bredd - 8}), []


def knappar(arg):
    ladda_typsnitt()
    TILLSTAND["oppnad"] = True
    bredd = TILLSTAND["bredd"]
    ut = {}
    for adress in arg:
        form = next((f for f in tolkning().formular if f["action"] == adress), None)
        if form is None or not form["knapp"] or galler("utan_formular", adress):
            ut[adress] = None
        elif galler("knapp_dold", adress):
            # Knappen finns men ritas inte: inga kanter, som modulens KANTER ger.
            ut[adress] = [0, 0]
        else:
            ut[adress] = [8, bredd + 40 if galler("knapp_utanfor", adress) else bredd - 8]
    return varde(ut), []


def omdirigera(fran, status, mal):
    # Som Chromium efter en omdirigering: nasta begaran bar den forra statusen i redirectResponse.
    ny = urllib.parse.urljoin(fran, mal)
    handelser = [("Network.requestWillBeSent", {"type": "Document", "request": {"url": ny, "method": "GET"},
                                                 "redirectResponse": {"url": fran, "status": status}})]
    status, slut, kropp, _ = hamta(urllib.request.Request(ny))
    ny_sida(slut, kropp)
    return handelser + sidhandelser(slut, status)


def skicka(arg):
    adress, falt = arg["adress"], arg["falt"]
    form = next((f for f in tolkning().formular if f["action"] == adress), None)
    if (form is None or not form["knapp"] or galler("utan_formular", adress)
            or any(namn not in dict(form["falt"]) for namn in falt)):
        return varde({"skickat": False}), []
    url = urllib.parse.urljoin(TILLSTAND["url"], adress)
    if galler("skicka_inte", adress):
        # Inget POST: bara omdirigeringen till ATTRAPP_PLATS rapporteras.
        return varde({"skickat": True}), omdirigera(url, 303, PLATS)
    sidan = urllib.parse.urlsplit(TILLSTAND["url"])
    kropp = urllib.parse.urlencode([(namn, falt.get(namn, v)) for namn, v in form["falt"]]).encode("ascii")
    begaran = urllib.request.Request(url, data=kropp, method="POST", headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "%s://%s" % (sidan.scheme, sidan.netloc),
        "Sec-Fetch-Site": "same-origin",
    })
    status, _, svarskropp, plats = hamta(begaran, IngenOmdirigering())
    if status in OMDIRIGERINGAR and plats is not None:
        if galler("ingen_omdirigering", adress):
            # Omdirigeringen foljs inne i attrappen; bara den sista sidan rapporteras.
            status, slut, svarskropp, _ = hamta(urllib.request.Request(urllib.parse.urljoin(url, plats)))
            ny_sida(slut, svarskropp)
            return varde({"skickat": True}), sidhandelser(slut, status)
        return varde({"skickat": True}), omdirigera(url, status, PLATS if galler("annan_plats", adress) else plats)
    ny_sida(url, svarskropp)
    return varde({"skickat": True}), sidhandelser(url, status)


SKRIPTEN = {"matning": matning, "meny": meny, "knappar": knappar, "skicka": skicka}


def utvardera(params):
    # Namnet och argumentet star i market; attrappen tolkar aldrig skriptet.
    traff = MARKE.match(params.get("expression", ""))
    if traff is None or traff.group(1) not in SKRIPTEN or sidlage("skript_fel"):
        return {"result": {"type": "object", "subtype": "error"},
                "exceptionDetails": {"exceptionId": 1, "text": "Uncaught"}}, []
    return SKRIPTEN[traff.group(1)](json.loads(base64.b64decode(traff.group(2)).decode("utf-8")))


METODER = {
    "Target.createTarget": skapa_mal,
    "Target.attachToTarget": koppla,
    "Page.enable": aktivera,
    "Network.enable": aktivera,
    "Emulation.setDeviceMetricsOverride": emulera,
    "Page.navigate": navigera,
    "Runtime.evaluate": utvardera,
    "Browser.close": aktivera,
}


def svara(meddelande):
    metod = meddelande.get("method")
    params = meddelande.get("params") or {}
    if metod == "Emulation.setDeviceMetricsOverride" and galler("cdp_fel"):
        skriv({"id": meddelande["id"], "error": {"code": -32000, "message": "attrappens fel"}})
        return
    hanterare = METODER.get(metod)
    if hanterare is None:
        skriv({"id": meddelande["id"], "error": {"code": -32601, "message": "okand metod"}})
        return
    resultat, handelser = hanterare(params)
    # Svaret skrivs alltid fore handelserna som anropet ger, och handelserna bar anropets session.
    skriv({"id": meddelande["id"], "result": resultat})
    for namn, data in handelser:
        handelse = {"method": namn, "params": data}
        if "sessionId" in meddelande:
            handelse["sessionId"] = meddelande["sessionId"]
        skriv(handelse)
    if metod == "Runtime.evaluate":
        logga({"svar": metod, "skript": skriptnamn(params)})


def main():
    argv = sys.argv[1:]
    if not all(f in argv for f in FLAGGOR) or not any(a.startswith(PROFILFLAGGA) for a in argv):
        sys.exit(9)
    logga({"argv": argv, "pid": os.getpid()})
    if galler("startar_inte"):
        sys.exit(1)
    for meddelande in meddelanden():
        metod = meddelande.get("method")
        params = meddelande.get("params") or {}
        if metod == "Runtime.evaluate":
            logga({"method": metod, "skript": skriptnamn(params)})
        else:
            logga({"method": metod, "params": params})
        # tyst laser men svarar aldrig, inte heller pa Browser.close.
        if galler("tyst"):
            continue
        svara(meddelande)
        if metod == "Browser.close":
            sys.exit(0)
    sys.exit(0)


if __name__ == "__main__":
    main()
