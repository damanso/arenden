#!/usr/bin/env python3
"""Arendelankprovet (D-5, D-2, B-21 matningen i tva steg, B-17 Tre utfall, Story 11.7).

Kors utan argument. Inforandet sker utanfor bygget: modulen kopieras oforandrad
som prov under kanalens prov_prefix arende (forkrav i drift).

Invarianter:
1. En enda vag in: konfigurationen lases bara av konfiguration, med ett try
   runt lasningen och formen. Ett fel ger KUNDE_INTE och hamtar ingenting.
   Appens och ytans bas ar loopback och aldrig en databasport.
2. En enda vag ut: hamta ar den enda funktionen som oppnar en adress. Den
   foljer aldrig en omdirigering, anvander aldrig en proxy och skickar GET
   utan kropp. Bara fraga_action skickar POST.
3. En arendelank hoppas aldrig over: varje href med arendesokvagen blir ett
   mal genom till_mal eller ett fel. Ett mal foljs med hogst en 308 inom
   samma ursprung; varje annat svar ar trasigt och inget svar ett fel.
4. Bara lasning: fraga_action tar bara namn ur LASACTIONS, och manifestet ska
   visa dem som lasande fore den forsta POST. Nyckeln skickas bara till appens
   /api och star aldrig i en utskriftsrad. Raderna byggs bara av konstanter,
   sidnamn, tal, typnamn och varden utifran i sluten form: varje href, kortets
   id och arendets lank gar genom sluten, sa att en rad aldrig delas och inget
   varde utifran skriver ett Python-felnamn eller orden kunde inte.
5. Korten lases i en sluten form. En etikett utanfor ett kort och en sida
   utan kort for plattformens insatser med arende ar fel, aldrig en tyst
   jamforelse. Fynden till kanalen Beslutskon ar inga fel.
6. doma provar fel forst, tomma sidor sedan, trasiga lankar sist fore GRON.
   Fynden i Din insats andrar aldrig utfallet. Exitkoden kommer bara ur UTFALL.
7. huvud gor varje undantag till KUNDE_INTE, sa att en krasch aldrig blir 1.
"""
import html.parser
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import NamedTuple, Optional

# Konfigurationen ligger under hemmet. I drift skrivs den av forkravet, i kopian av provfilen.
KONFIGFIL = (".hermes", "arendelankar.json")
NYCKLAR = ("app", "ga_igenom", "nyckelfil", "publik", "sokord", "yta")
VARD = "127.0.0.1"
# Redovisningens, utvecklingsdatabasens och testdatabasens portar (projektkontexten).
DATABASPORTAR = (5433, 5435, 5436)
# Samma text som ARENDEPREFIX i src/lib/arendelank.ts (K-9: provfilen binder de tva).
ARENDEPREFIX = "/vy/arende/"
# Etiketten pa sidan har a och o med prickar; escapen haller modulens kod i ASCII.
ETIKETT = "D\xe4r handlingen g\xf6rs"
# Ett sokord utan siffror tolkas aldrig som ett arendenummer: /vy/sok svarar 200 och omdirigerar inte.
SOKORDFORM = re.compile(r"[A-Za-z]{2,40}")
# En eller flera leder; formen utesluter //, .., versaler och en fraga.
SOKVAGSFORM = re.compile(r"(?:/[a-z0-9_-]+)+")
SIDOR = ("oversikt", "mitt", "digest", "sok", "din_insats", "ga_igenom", "list_issues", "list_insatser",
         "arendesidor")
# Sokvagen None byggs ur konfigurationen: sokordet for sok och adressen till Ga igenom.
STARTSIDOR = (("oversikt", "app", "/vy"), ("mitt", "app", "/vy/mitt"), ("digest", "app", "/vy/digest?dagar=7"),
              ("sok", "app", None), ("din_insats", "yta", "/beslut"), ("ga_igenom", "yta", None))
LASACTIONS = ("list_issues", "list_insatser")


class Konfig(NamedTuple):
    app: str
    yta: str
    publik: str
    nyckel: str
    sokord: str
    ga_igenom: str


class Konfiglage(NamedTuple):
    konfig: Optional[Konfig]
    fel: Optional[str]


def orsak(fel):
    # Ett ValueError bar en text ur modulens slutna tabeller. Varje annat undantag, ocksa
    # JSONDecodeError och UnicodeDecodeError, ger bara sitt typnamn och aldrig ett varde.
    return str(fel) if type(fel) is ValueError else type(fel).__name__


# Den slutna formen for ett varde utifran i en rad (invariant 4). ASCII-bokstaver, siffror och tecknen
# . _ ~ : / ? = & - star kvar; varje annat tecken, ocksa procenttecknet, procentkodas som utf-8. I en foljd av
# bokstaver med bade versaler och gemener procentkodas versalerna, sa att inget Python-felnamn star kvar.
VARDEDEL = re.compile(r"[A-Za-z]+|[^A-Za-z0-9._~:/?=&-]")


def procent(tecken):
    # surrogatepass: ocksa en ensam surrogat ur ett svar far en kodning och stoppar inte korningen.
    return "".join("%%%02X" % b for b in tecken.encode("utf-8", "surrogatepass"))


def sluten(varde):
    def ersatt(traff):
        bit = traff.group(0)
        if not (bit.isascii() and bit.isalpha()):
            return procent(bit)
        if bit.isupper() or bit.islower():
            return bit
        return "".join(procent(t) if t.isupper() else t for t in bit)
    return VARDEDEL.sub(ersatt, varde)


def ar_loopback(varde):
    try:
        delar = urllib.parse.urlsplit(varde)
        port = delar.port
    except ValueError:
        return False
    # Likheten med schema och natplats utesluter ocksa ett tomt '?' eller '#' sist.
    return (delar.scheme == "http" and delar.hostname == VARD and port is not None
            and delar.path == "" and delar.query == "" and delar.fragment == ""
            and delar.username is None and varde == "http://" + delar.netloc)


def ar_https_ursprung(varde):
    try:
        delar = urllib.parse.urlsplit(varde)
        delar.port
    except ValueError:
        return False
    return delar.scheme == "https" and bool(delar.hostname) and varde == "https://" + delar.netloc


def konfiguration(hem):
    try:
        with open(os.path.join(hem, *KONFIGFIL), "rb") as fil:
            data = json.loads(fil.read().decode("utf-8"))
        # Tabellens ordning: fel nycklar, ocksa ett varde som inte ar text, fore varje formregel.
        if (not isinstance(data, dict) or sorted(data) != sorted(NYCKLAR)
                or not all(isinstance(v, str) for v in data.values())):
            raise ValueError("fel nycklar")
        for namn in ("app", "yta"):
            if not ar_loopback(data[namn]):
                raise ValueError("%s ar ingen loopbackadress" % namn)
        for namn in ("app", "yta"):
            if urllib.parse.urlsplit(data[namn]).port in DATABASPORTAR:
                raise ValueError("%s ar en databasport" % namn)
        if not ar_https_ursprung(data["publik"]):
            raise ValueError("publik ar ingen https-adress")
        if not SOKORDFORM.fullmatch(data["sokord"]):
            raise ValueError("sokordet gar inte att tolka")
        if not SOKVAGSFORM.fullmatch(data["ga_igenom"]):
            raise ValueError("ga_igenom gar inte att tolka")
        if not os.path.isabs(data["nyckelfil"]):
            raise ValueError("nyckelfilen ar inte en absolut sokvag")
        with open(data["nyckelfil"], "rb") as fil:
            nyckel = fil.read().decode("utf-8").strip()
        if not nyckel:
            raise ValueError("nyckelfilen ar tom")
        return Konfiglage(Konfig(data["app"], data["yta"], data["publik"], nyckel, data["sokord"],
                                 data["ga_igenom"]), None)
    except Exception as fel:
        return Konfiglage(None, orsak(fel))


TIDSGRANS = 20


class IngenOmdirigering(urllib.request.HTTPRedirectHandler):
    # Utan ny begaran nar svaret HTTPDefaultErrorHandler: en 308 kommer tillbaka som
    # HTTPError med sin Location, och bara folj avgor om den foljs.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Svar(NamedTuple):
    status: Optional[int]
    plats: Optional[str]
    text: Optional[str]
    fel: Optional[str]


def hamta(adress, nyckel=None, kropp=None):
    try:
        data = None if kropp is None else json.dumps(kropp).encode("utf-8")
        begaran = urllib.request.Request(adress, data=data, method="GET" if data is None else "POST")
        if data is not None:
            begaran.add_header("Content-Type", "application/json")
        if nyckel is not None:
            begaran.add_header("Authorization", "Bearer " + nyckel)
        # ProxyHandler({}) stanger av proxyvariablerna: loopback nas alltid direkt.
        oppnare = urllib.request.build_opener(urllib.request.ProxyHandler({}), IngenOmdirigering())
        try:
            svar = oppnare.open(begaran, timeout=TIDSGRANS)
        except urllib.error.HTTPError as fel:
            svar = fel
        try:
            return Svar(svar.getcode(), svar.headers.get("Location"),
                        svar.read().decode("utf-8", errors="replace"), None)
        finally:
            svar.close()
    except Exception as fel:
        return Svar(None, None, None, type(fel).__name__)


def ursprung(adress):
    try:
        delar = urllib.parse.urlsplit(adress)
        port = delar.port
    except ValueError:
        return None
    if port is None:
        port = {"https": 443, "http": 80}.get(delar.scheme)
    # urlsplit ger schemat och vardnamnet i gemener.
    return (delar.scheme, delar.hostname, port)


def till_mal(adress, konfig):
    # Tillatelselistan har tre ursprung: lasvyns publika och appens gar till appen, ytans till ytan.
    kalla = ursprung(adress)
    if kalla in (ursprung(konfig.publik), ursprung(konfig.app)):
        bas = konfig.app
    elif kalla == ursprung(konfig.yta):
        bas = konfig.yta
    else:
        return None, "lanken gar till ett ursprung som provet inte nar"
    delar = urllib.parse.urlsplit(adress)
    if not delar.path.startswith(ARENDEPREFIX):
        return None, "lanken ar ingen arendeadress"
    return bas + delar.path + ("?" + delar.query if delar.query else ""), None


class Lank(NamedTuple):
    href: str
    mal: Optional[str]
    fel: Optional[str]


class Hrefsamlare(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hrefs = []

    def handle_starttag(self, tagg, attribut):
        if tagg == "a":
            href = next((varde for namn, varde in attribut if namn == "href"), None)
            if href is not None:
                self.hrefs.append(href)


def lankar(text, sidans_adress, konfig):
    samlare = Hrefsamlare()
    samlare.feed(text)
    samlare.close()
    ut = []
    for href in samlare.hrefs:
        adress = urllib.parse.urljoin(sidans_adress, href.strip())
        # Ett arendes lank borjar alltid med prefixet (arendeLank), sa regeln tacker bada leden i AK 1.
        if urllib.parse.urlsplit(adress).path.startswith(ARENDEPREFIX):
            mal, fel = till_mal(adress, konfig)
            ut.append(Lank(adress, mal, fel))
    return tuple(ut)


class Foljd(NamedTuple):
    status: Optional[str]
    trasig: bool
    fel: Optional[str]
    text: Optional[str]
    slut: Optional[str]


def folj(mal):
    svar = hamta(mal)
    if svar.fel is not None:
        return Foljd(None, False, svar.fel, None, None)
    if svar.status == 200:
        return Foljd("200", False, None, svar.text, mal)
    if svar.status != 308:
        return Foljd(str(svar.status), True, None, None, None)
    if not svar.plats:
        return Foljd("308 utan plats", True, None, None, None)
    plats = urllib.parse.urljoin(mal, svar.plats.strip())
    if ursprung(plats) != ursprung(mal):
        return Foljd("308 till ett annat ursprung", True, None, None, None)
    andra = hamta(plats)
    if andra.fel is not None:
        return Foljd(None, False, andra.fel, None, None)
    if andra.status == 200:
        return Foljd("308 och sedan 200", False, None, andra.text, plats)
    return Foljd("308 och sedan %d" % andra.status, True, None, None, None)


# LimitSchema tar hogst 100 (src/actions/registry.ts rad 139).
SIDSTORLEK = 100
SIDTAK = 100


class Apilage(NamedTuple):
    arenden: tuple[tuple[str, str], ...]
    insatser: tuple[tuple[str, Optional[str]], ...]
    fel: Optional[str]


def fraga_action(konfig, namn, indata):
    # Det enda stallet i modulen som skickar en kropp.
    if namn not in LASACTIONS:
        raise ValueError("actionen ar inte lasande")
    return hamta(konfig.app + "/api/actions/" + namn, konfig.nyckel, indata)


def svarets_json(svar):
    if svar.fel is not None:
        raise ValueError(svar.fel)
    if svar.status != 200:
        raise ValueError("status %d" % svar.status)
    return json.loads(svar.text)


def resultatet(svar, namn):
    # Kuvertet ur src/actions/execute.ts; modulen laser bara result.
    kuvert = svarets_json(svar)
    if not isinstance(kuvert, dict) or kuvert.get("status") != "ok" or kuvert.get("action") != namn:
        raise TypeError("svaret ar inget kuvert")
    return kuvert["result"]


def lista(varde):
    if not isinstance(varde, list):
        raise TypeError("ingen lista")
    return varde


def text(varde):
    if not isinstance(varde, str):
        raise TypeError("ingen text")
    return varde


def plattformens_svar(konfig):
    steg = "actions"
    try:
        manifest = svarets_json(hamta(konfig.app + "/api/actions", konfig.nyckel))
        if not isinstance(manifest, dict):
            raise TypeError("manifestet ar inget objekt")
        poster = lista(manifest.get("actions"))
        for namn in LASACTIONS:
            if not any(isinstance(p, dict) and p.get("name") == namn and p.get("sensitivity") == "read"
                       for p in poster):
                raise ValueError("%s ar inte lasande" % namn)
        steg = "list_issues"
        # Utan filter pa tillstand kommer ocksa de stangda arendena med.
        arenden, indata = [], {"limit": SIDSTORLEK}
        for _ in range(SIDTAK):
            resultat = resultatet(fraga_action(konfig, "list_issues", indata), "list_issues")
            for rad in lista(resultat["arenden"]):
                arenden.append((text(rad["identifier"]), text(rad["lank"])))
            har_nasta = resultat["pageInfo"]["har_nasta"]
            if har_nasta is False:
                break
            if har_nasta is not True:
                raise TypeError("har_nasta ar inget sanningsvarde")
            indata = {"limit": SIDSTORLEK, "cursor": resultat["pageInfo"]["slut_cursor"]}
        else:
            raise ValueError("sidtaket overskreds")
        steg = "list_insatser"
        # Standardfiltret: vantande, och uppskjutna vars vackningstid passerat.
        insatser = []
        for post in lista(resultatet(fraga_action(konfig, "list_insatser", {}), "list_insatser")):
            lank = post["lank"]
            insatser.append((text(post["id"]), None if lank is None else text(lank)))
        return Apilage(tuple(arenden), tuple(insatser), None)
    except Exception as fel:
        return Apilage((), (), "%s (%s)" % (steg, orsak(fel)))


class Kort(NamedTuple):
    id: str
    etikett: bool
    href: Optional[str]


class Kortlage(NamedTuple):
    kort: tuple[Kort, ...]
    fel: Optional[str]


class Jamforelse(NamedTuple):
    fynd: tuple[str, ...]
    kort: int
    jamforda: int
    fel: Optional[str]


class Kortlasare(html.parser.HTMLParser):
    # Kortformen: ett kort borjar vid varje starttagg med data-insats och racker till nasta.
    # Dess lank ar den forsta a med href efter kortets forsta etikett.
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.kort = []
        self.fel = None

    def handle_starttag(self, tagg, attribut):
        for namn, varde in attribut:
            if namn == "data-insats":
                self.kort.append([(varde or "").strip(), False, None])
                break
        if tagg == "a" and self.kort and self.kort[-1][1] and self.kort[-1][2] is None:
            href = next((varde for namn, varde in attribut if namn == "href"), None)
            if href is not None:
                self.kort[-1][2] = href.strip()

    def handle_data(self, data):
        if " ".join(data.split()) in (ETIKETT, ETIKETT + ":"):
            if self.kort:
                self.kort[-1][1] = True
            elif self.fel is None:
                self.fel = "Dar handlingen gors star utanfor ett kort"


def korten(text):
    lasare = Kortlasare()
    lasare.feed(text)
    lasare.close()
    return Kortlage(tuple(Kort(*kort) for kort in lasare.kort), lasare.fel)


def jamfor_korten(kortlage, insatser):
    # Ett kort jamfors bara nar dess id ar exakt ett id ur plattformens svar; vakten for en
    # sida utan sadana kort fangar en annan id-form i ytan (Story 11.3: ytan ar Beslutskons kod).
    karta = {id_: lank for id_, lank in insatser if lank is not None}
    fynd, jamforda = [], 0
    for kort in kortlage.kort:
        if kort.id not in karta:
            continue
        jamforda += 1
        lank = karta[kort.id]
        # Id, href och lank kommer utifran och star bara i sluten form i raden (invariant 4).
        if kort.href is None:
            fynd.append("FYND till kanalen Beslutskon: insats %s: Dar handlingen gors saknas eller har ingen "
                        "lank, arendets lank ar %s" % (sluten(kort.id), sluten(lank)))
        elif kort.href != lank:
            fynd.append("FYND till kanalen Beslutskon: insats %s: Dar handlingen gors pekar pa %s, "
                        "arendets lank ar %s" % (sluten(kort.id), sluten(kort.href), sluten(lank)))
    if kortlage.fel is not None:
        fel = "din_insats: " + kortlage.fel
    elif karta and jamforda == 0:
        fel = "din_insats: inget kort galler en insats med arende"
    else:
        fel = None
    return Jamforelse(tuple(fynd), len(kortlage.kort), jamforda, fel)


# Unika hamtningar i en korning: ett tak som nas ger KUNDE_INTE, aldrig en tyst avkapning.
LANKTAK = 5000
UTFALL = {"GRON": 0, "ROD": 1, "KUNDE_INTE": 2}
GRON_RAD = "GRON: varje arendelank i ytan och appen svarar 200 efter hogst en 308"
ROD_RAD = "ROD: en arendelank i ytan eller appen svarar inte 200"
KUNDE_INTE_RAD = "KUNDE_INTE: arendelankarna gar inte att prova"


class Dom(NamedTuple):
    utfall: str
    kod: int
    rader: tuple[str, ...]


def startadress(namn, bas, sokvag, konfig):
    if namn == "sok":
        sokvag = "/vy/sok?q=" + konfig.sokord
    elif namn == "ga_igenom":
        sokvag = konfig.ga_igenom
    return (konfig.app if bas == "app" else konfig.yta) + sokvag


def doma(konfigfel, foljda, fel, trasiga, fynd, kort, jamforda):
    if konfigfel is not None:
        return Dom("KUNDE_INTE", UTFALL["KUNDE_INTE"], (KUNDE_INTE_RAD, "FEL: konfigurationen: " + konfigfel))
    # Minst en foljd lank per post i SIDOR: en sida dar inget foljdes har inte visat nagot.
    felrader = ["FEL: " + f for f in fel]
    felrader += ["FEL: inga lankar foljdes pa " + namn for namn in SIDOR if not foljda.get(namn)]
    if felrader:
        utfall, forsta = "KUNDE_INTE", KUNDE_INTE_RAD
    elif trasiga:
        utfall, forsta = "ROD", ROD_RAD
    else:
        utfall, forsta = "GRON", GRON_RAD
    rader = [forsta]
    rader += ["sida %s: foljda=%d" % (namn, len(foljda.get(namn, ()))) for namn in SIDOR]
    rader.append("kort i din_insats: kort=%d jamforda=%d" % (kort, jamforda))
    return Dom(utfall, UTFALL[utfall], tuple(rader + felrader + list(trasiga) + list(fynd)))


def kor(hem):
    lage = konfiguration(hem)
    if lage.fel is not None:
        return doma(lage.fel, {}, (), (), (), 0, 0)
    konfig = lage.konfig
    foljda = {namn: set() for namn in SIDOR}
    fel, trasiga, fynd = [], [], []
    kort = jamforda = 0
    # Forradet ar nycklat pa malet: varje unikt mal foljs en gang i korningen.
    forrad, ko, koade = {}, [], set()
    appens = ursprung(konfig.app)

    def notera(rader, rad):
        if rad not in rader:
            rader.append(rad)

    def folj_under(namn, lank):
        # Hrefen kommer ur en sida eller ett svar och star bara i sluten form i raderna (invariant 4).
        href = sluten(lank.href)
        if lank.fel is not None:
            notera(fel, "%s: sida %s: %s" % (lank.fel, namn, href))
            return
        foljda[namn].add(lank.mal)
        if lank.mal not in forrad:
            if len(forrad) >= LANKTAK:
                notera(fel, "taket pa %d lankar nades, resten foljdes inte" % LANKTAK)
                return
            forrad[lank.mal] = folj(lank.mal)
        foljd = forrad[lank.mal]
        if foljd.fel is not None:
            notera(fel, "lanken svarar inte: sida %s: %s (%s)" % (namn, href, foljd.fel))
        elif foljd.trasig:
            notera(trasiga, "TRASIG: sida %s: lank %s: status %s" % (namn, href, foljd.status))
        elif (foljd.slut not in koade and ursprung(foljd.slut) == appens
              and urllib.parse.urlsplit(foljd.slut).path.startswith(ARENDEPREFIX)):
            # Varje arendesida i appen laggs i kon en gang; plattformen har andligt manga arenden.
            koade.add(foljd.slut)
            ko.append(foljd)

    api = plattformens_svar(konfig)
    if api.fel is not None:
        fel.append("plattformens api: " + api.fel)
    for namn, poster in (("list_issues", api.arenden), ("list_insatser", api.insatser)):
        for _, adress in poster:
            if adress is not None:
                mal, lankfel = till_mal(adress, konfig)
                folj_under(namn, Lank(adress, mal, lankfel))
    for namn, bas, sokvag in STARTSIDOR:
        adress = startadress(namn, bas, sokvag, konfig)
        svar = hamta(adress)
        if svar.fel is not None:
            notera(fel, "sidan nas inte: %s (%s)" % (namn, svar.fel))
            continue
        if svar.status != 200:
            notera(fel, "sidan nas inte: %s (status %d)" % (namn, svar.status))
            continue
        for lank in lankar(svar.text, adress, konfig):
            folj_under(namn, lank)
        if namn == "din_insats" and api.fel is None:
            jamforelse = jamfor_korten(korten(svar.text), api.insatser)
            fynd, kort, jamforda = list(jamforelse.fynd), jamforelse.kort, jamforelse.jamforda
            if jamforelse.fel is not None:
                notera(fel, jamforelse.fel)
    # Sidans text ar texten ur forradets Foljd: ingen arendesida hamtas en gang till for att lasas.
    while ko:
        sida = ko.pop(0)
        for lank in lankar(sida.text, sida.slut, konfig):
            folj_under("arendesidor", lank)
    return doma(None, foljda, fel, trasiga, fynd, kort, jamforda)


ANROPSRAD = "KUNDE_INTE: anropet gar inte att tolka: provet tar inga argument"


def huvud(argument):
    try:
        if argument:
            print(ANROPSRAD)
            return UTFALL["KUNDE_INTE"]
        dom = kor(os.path.expanduser("~"))
        # En enda skrivning: ett fel i utskriften lamnar aldrig en forsta rad utan sin exitkod.
        print("\n".join(dom.rader))
        return dom.kod
    except Exception as fel:
        print("KUNDE_INTE: arendelankar stannade: %s" % type(fel).__name__)
        return UTFALL["KUNDE_INTE"]


if __name__ == "__main__":
    sys.exit(huvud(sys.argv[1:]))
