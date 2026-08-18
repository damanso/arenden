# Kravspec — Etapp 2a: Davids läsvy

```
MAL | Etapp 2a av arendeplattformen: DAVIDS LASVY — serverrenderad HTML i arendens befintliga express-server under nya rutter /vy, dar David far overblick over oppna arenden, digesten "vad hande", fritextsok med fasetter och en arendesida med full historik och synlig proveniens. Detta ar forsta produktionsversionen han oppnar for att granska plattformen.
KALLA | Davids beslut #21 (etapp 2a) + Davids formulering "vad jag ska kunna se nar jag gar in och tittar, bade overblick och att kunna soka aktiviteten" + /home/hermes/brain/02-Områden/hermes/arendeplattform-research-2026-08-18.md (Davids ytor-krav: overblick/sok/aktivitetsflode med proveniens) + .../arendeplattform-extern-research-2026-08-18.md (digest-vy, fasetterad sok, serverrenderad HTML, AI Act art 50) + monsterkallan /home/hermes/.hermes/services/ytor_server.py (tailnet-modellen, kort-layout, CSS) + docs/KRAVSPEC-ETAPP-1.md.
ARKITEKTUR | Vyn bor i arendens Node-server (samma process, port 3002, bind 127.0.0.1 — oforandrat): EN vy-routerfil (src/http/routes/vy.ts) monterad pa /vy i createApp FORE nyckelkravet — lasvyn kraver ingen API-nyckel, tailnet ar gransen precis som for ytor_server — plus EN templatehjalpare (t.ex. src/http/vy/mall.ts) med template literals; ingen templatemotor, inga ramverk, inga nya beroenden. HTML:en ar JS-fri (eller minimal inline-JS), mobilvanlig (viewport, kort-layout, light/dark enligt ytor_servers CSS-monster) — vyn ska KANNAS som redovisningens/ytornas.
ARKITEKTUR | Ingen SQL i vylagret: all datahamtning via befintliga tjanstefunktioner/actions (listaArenden, hamtaArende, sokArenden, listaKommentarer, listaHandelser, listaStates); saknas en lasfraga (t.ex. tenantvid handelselista for digesten, aktorsfiltrering) laggs den i tjanstelagret (src/services/), aldrig i routern. Vyn ar REN LASYTA: endast GET, inga mutationer, inga event-rader skrivs.
KRAV-1 | GET /vy — OVERBLICK med huvudrubriken "Arenden": oppna arenden (state-typ backlog/unstarted/started) grupperade per projekt och team, varje arende med status, prio och due synliga; raknare per grupp och totalt; senast uppdaterade/aktiva overst inom grupperna.
KRAV-2 | GET /vy/digest — "vad hande": handelser ur events-tabellen grupperade per dag (nyaste dagen overst) och inom dagen per kalla (agent/manniska/system), varje rad med tid, aktor, verb och lank till arendet (LOC-N); rimligt fonster (t.ex. senaste 7 dagarna eller senaste N handelser) med lank att visa aldre.
KRAV-3 | GET /vy/sok — SOK: fritext via ?q= mot tsvector-sokningen (search_issues/sokArenden: titel + beskrivning + kommentarer, rankad) + fasetter som RENA lankparametrar (?status=&etikett=&projekt=&aktor=): status/etikett/projekt filtrerar arendetraffarna (samma filter som list_issues), aktor filtrerar pa aktivitet (arenden med handelser/kommentarer av aktoren); aktiva fasetter visas och kan tas bort via lank; utan q visas sokformular + fasettlankar. Inga skript kravs — formularet ar GET.
KRAV-4 | GET /vy/arende/LOC-N — ARENDESIDA: titel, status, prio, due, projekt, labels och beskrivning, darefter alla kommentarer och HELA handelsehistoriken i tidsordning; okand identifier ger 404 som vanlig HTML-sida.
KRAV-5 | Proveniens synlig OVERALLT dar kommentarer/handelser visas: varje rad markt med aktor_typ + aktor_namn ur databasen; AI-genererat (aktor_typ agent) MARKS tydligt och konsekvent (t.ex. badge "agent · <namn>" — AI Act art 50), manniska och system marks pa sina satt — ingen rad ar omarkt. Markningen kommer ALLTID ur events/comments-kolumnerna, aldrig ur fri text.
KRAV-6 | All dynamisk text HTML-escapas via EN escape-funktion i templatehjalparen som anvands overallt — arkivdata innehaller markdown, citattecken och lankar och far aldrig bli injicerad HTML.
KRAV-7 | Svenska i hela granssnittet. Huvudrubrik "Arenden". Inga lankar till Linear — detta AR kallan.
KRAV-8 | Sakerhetsmodellen oforandrad: servern binder ENDAST 127.0.0.1; /vy undantas fran nyckelkravet men /api ar fortsatt skyddat med bearer precis som idag; README far ett dokumenterat tailscale serve-kommando for ny port 8446 (exponering pa tailnet) — kommandot KORS INTE i denna etapp.
KRAV-9 | package.json far scriptet `check` som kor bygget och hela testsviten (tsc noll fel → vitest) — ETT kommando for granskaren.
KRAV-10 | Tester (vitest + supertest genom hela stacken mot testdatabasen, importfixturerna i test/fixtures/arkiv/ inlasta): (a) GET /vy ger 200, rubriken "Arenden" och kand importdata; (b) GET /vy/arende/LOC-316 ger 200 och innehaller fixturens titel; (c) GET /vy/sok med kant ord ger traff, inklusive ord som bara finns i en kommentar; (d) okant arende ger 404; (e) proveniens-markningen verifieras i HTML — agent-rad bar agent-markningen, manniska-rad gor det inte; (f) /vy svarar utan nyckel medan skrivande /api-anrop utan nyckel fortsatt ger 401.
ACCEPTANS | `npm run check` gront (tsc noll fel + hela testsviten inkl. etapp 1:s befintliga tester) — inklistrad utdata, inga pastaenden utan korning.
ACCEPTANS | Servern startar (npm start efter build) och GET /vy, /vy/digest, /vy/sok?q=..., /vy/arende/LOC-316 svarar 200 med verklig importerad data (de 312 arendena fran etapp 1-importen); LOC-316-sidan matchar arkivfilen.
ACCEPTANS | Granskaren far endast denna spec + de pekade dokumenten och kan bocka av varje KRAV mot kod och test utan egen letning (BMAD); vyn kontrolleras i mobilbredd (kort-layouten haller).
ACCEPTANS | Prod oberord: /opt/redovisning, ~/.hermes/skills och ytor_server ororda; package.json har inga nya beroenden; /api-beteendet oforandrat; tailscale serve INTE kort.
AVGRANSNING | Ingen skrivfunktion fran vyn (inga POST-rutter under /vy), ingen auth-UI, inga notiser, ingen cutover — Linear ar fortsatt skarp kalla och de 15 skripten rors inte.
AVGRANSNING | Inga nya beroenden och ingen templatemotor (express + template literals racker), ingen klient-JS utover ev. minimal inline, ingen SQL i vylagret, ingen exponering utanfor 127.0.0.1 i denna etapp.
```

## Tre beslut som togs där underlaget lämnade utrymme

1. **`aktor`-fasetten filtrerar på aktivitet** (händelser/kommentarer), inte på ett
   fält hos ärendet — ärenden har ingen aktör, och kravet var att söka
   *aktiviteten*. Det kräver en ny läsfunktion i tjänstelagret
   (`arendenMedAktivitetAv`), vilket ARKITEKTUR-raden uttryckligen tillåter.
2. **`npm run check` fanns inte** — KRAV-9 inför scriptet eftersom acceptansen
   kräver ETT kommando för granskaren.
3. **HTML-escaping fick ett eget krav (KRAV-6)** — det stod inte i det ursprungliga
   scopet men är obligatoriskt när databasinnehåll serverrenderas utan ramverk.

Var varje krav är uppfyllt i kod och test: se tabellen "Etapp 2a — krav → kod och
test" i [`../README.md`](../README.md).
