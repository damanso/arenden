# Ärendeplattformen — Etapp 1 (skuggdrift) + Etapp 2a (läsvyn)

Egen ärendeplattform som ersätter Linears API-yta för agenterna: datamodell,
actions-API med proveniens, import av linear-arkivet och adapter. **Ingen
cutover** — Linear är fortfarande skarp källa, och varken `~/.hermes/skills`
eller `/opt/redovisning` rörs. Omkopplingen av de 15 skripten är Etapp 2.

Etapp 2a lägger till **läsvyn** på `/vy`: överblick, digest, sök och ärendesida
som serverrenderad HTML i samma process. Ren läsyta — inga skrivrutter.

Kravspecarna som bygget svarar mot:
[`docs/KRAVSPEC-ETAPP-1.md`](docs/KRAVSPEC-ETAPP-1.md) ·
[`docs/KRAVSPEC-ETAPP-2A.md`](docs/KRAVSPEC-ETAPP-2A.md).

Arkitekturen är redovisningssystemets, oförändrad: transport → `executeAction` →
actions-registret → tjänstelagret → Postgres. `src/config.ts` är enda stället som
läser `process.env` (undantag: migrations-CLI:t och nyckelskriptet, som kör som
ägarrollen). Ingen SQL i registret, ingen affärslogik i http-lagret, inga
beroenden utanför den slutna stacklistan.

---

## Kör i den här ordningen

### 1. Starta båda databaserna

```bash
cd /opt/arenden
docker compose up -d                                # projekt: arenden       → 127.0.0.1:5435
docker compose -f docker-compose.test.yml up -d     # projekt: arenden-test  → 127.0.0.1:5436
```

Verifiera att de är EGNA compose-projekt och att inget annat system påverkats
(incidenten 17/8 — redovisningen kör på 5433 i sitt eget projekt):

```bash
docker compose ls
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker volume ls | grep arenden
```

### 2. Konfiguration

```bash
cp .env.example .env
```

Standardvärdena i `.env.example` pekar redan på 5435 och port 3002 — inget
behöver ändras för lokal drift.

### 3. Installera beroenden

```bash
npm install     # första gången i det här repot: skapar package-lock.json
```

Lockfilen är inte incheckad ännu (den skapas av kommandot ovan). **När den är
incheckad är `npm ci` kommandot** på en ren klon — det är den formen acceptansen
avser.

### 4. Migrera, bygg, testa

```bash
npm run migrate    # kör som ägarrollen via DATABASE_ADMIN_URL; återkörning = no-op
npm run check      # ETT kommando för granskaren: tsc (noll fel) + hela testsviten
```

`check` är `npm run build && npm test` — bygget och vitest/supertest mot RIKTIG
Postgres på 5436. De två stegen kan fortfarande köras var för sig.

`npm run migrate` en gång till ska svara `0 migration(er) kördes` — det är
idempotensen (KRAV-3).

### 5. Importera linear-arkivet

```bash
npm run import                                   # /home/hermes/brain/02-Områden/linear-arkiv
npm run import                                   # omedelbar omkörning: 0 nya (KRAV-16)
```

Första körningen läser de 312 `LOC-N.md`-filerna (`_las-mig.md` hoppas över),
behåller LOC-numreringen och sätter teamets sekvens över högsta numret så att
nästa nya ärende blir LOC-330. Andra körningen rapporterar 0 nya ärenden och 0
nya kommentarer.

### 6. Starta API:t och gör stickprovet

```bash
npm run nyckel -- agent hermes    # skriver ut nyckeln EN gång — spara den
npm run dev                       # (eller: npm run build && npm start)
```

I ett annat skal:

```bash
curl -s http://127.0.0.1:3002/health

curl -s -X POST http://127.0.0.1:3002/api/actions/get_issue \
  -H "Authorization: Bearer $NYCKEL" -H 'content-type: application/json' \
  -d '{"identifier":"LOC-316"}'

# Utan nyckel: 401 och ingen rad skrivs
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:3002/api/actions/create_issue \
  -H 'content-type: application/json' -d '{"title":"nej","team_key":"LOC"}'
```

### 7. Öppna läsvyn

```bash
open http://127.0.0.1:3002/vy          # eller i webbläsaren på maskinen
```

| Rutt | Vad den visar |
| --- | --- |
| `GET /vy` | **Ärenden** — öppna ärenden grupperade per projekt och team, räknare per grupp och totalt, färskast överst |
| `GET /vy/digest` | **Vad hände** — händelser per dag, inom dagen per källa (agent/människa/system); `?dagar=7\|30\|90\|alla` |
| `GET /vy/sok?q=...` | **Sök** — fritext över titel, beskrivning och kommentarer + fasetter `?status=&etikett=&projekt=&aktor=` |
| `GET /vy/arende/LOC-316` | **Ärendesidan** — fälten, beskrivningen, alla kommentarer och hela historiken |
| `GET /vy/mitt` | **Vad ligger på mig** — fem högar, var och en med sin regel utskriven; `?aktor=` väljer vem det ses från (K-9) |

Läsvyn kräver **ingen nyckel** (gränsen är att servern binder `127.0.0.1`) och är
**ren läsyta**: bara GET-rutter, inga mutationer, inga event-rader. `/api` är
oförändrat skyddat med bearer.

Snabbkoll utan nyckel:

```bash
for v in /vy /vy/digest '/vy/sok?q=hubspot' /vy/arende/LOC-316 /vy/arende/LOC-99999; do
  printf '%s ' "$v"; curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3002$v"
done     # 200 200 200 200 404
```

### 8. Exponering på tailnet — dokumenterad, INTE körd

Etapp 2a **kör inte** kommandot; servern binder fortfarande enbart `127.0.0.1`.
När vyn ska nås från Davids Mac/telefon är detta kommandot (ny port **8446** —
8444 är redovisningen, 8445 är ytor_server):

```bash
# Endast /vy exponeras — /api och /health lämnas kvar på loopback.
tailscale serve --bg --https=8446 --set-path=/vy http://127.0.0.1:3002/vy
# → https://david-brain.tail743706.ts.net:8446/vy   (endast tailnet)

tailscale serve status          # verifiera
tailscale serve --https=8446 off   # ta bort
```

---

## Vad som finns

| Del | Var |
| --- | --- |
| Migrationer (idempotent kedja) | `migrations/0001…0006_*.sql` |
| Konfiguration (enda env-läsaren) | `src/config.ts` |
| Actions-registret (`def`, zod-strict) | `src/actions/registry.ts` |
| `executeAction` (transaktion + proveniens-tvång) | `src/actions/execute.ts` |
| Tjänstelager (rå SQL, ingen ORM) | `src/services/` |
| HTTP (bara transport) | `src/http/` |
| Import av arkivet | `src/import/` |
| Adapter (TypeScript, bibliotek) | `src/adapter/index.ts` |
| Adapter (Python, endast stdlib) | `adapter/arenden_klient.py` |
| Läsvyn (Etapp 2a): router + mall | `src/http/routes/vy.ts`, `src/http/vy/mall.ts` |
| Dokumentlänkar: vitlista + index, markdown/autolänkning | `src/http/vy/dokument.ts`, `src/http/vy/markdown.ts` |
| Tester mot riktig Postgres | `test/` |

### Actions

`list_issues` · `get_issue` · `list_states` · `search_issues` · `sok_label`
(läsande) — `create_issue` · `update_issue_state` · `add_comment` ·
`claim_next_issue` (muterande, skriver alltid en event-rad).

Alla anropas likadant: `POST /api/actions/<namn>` med `Authorization: Bearer`.
Aktören (människa/agent/system + namn) tas **alltid ur nyckeln**, aldrig ur
request-body — det är boten mot "agentkommentarer stämplas David".

### Adaptrarna

Båda speglar dagens GraphQL-kontrakt och går över HTTP med bearer — aldrig direkt
mot databasen. De är **bibliotek**: inga skript kopplas om i Etapp 1.

```python
from arenden_klient import list_issues, update_issue_state, add_comment
for a in list_issues(state_typer=["backlog", "unstarted"])["noder"]:
    print(a["identifier"], a["title"])
```

---

## Krav → kod och test

| Krav | Kod | Test |
| --- | --- | --- |
| 1 projektskelett | `package.json`, `tsconfig.json` | `npm run build` |
| 2 egna compose-projekt | `docker-compose.yml` (`name: arenden`), `docker-compose.test.yml` (`name: arenden-test`) | `docker compose ls` |
| 3 migrationer som ägarroll, app icke-superuser | `src/db/migrate.ts`, `migrations/0001_grund.sql`, `src/db/pool.ts` | `test/schema.test.ts` |
| 4 tenant_id överallt + index | alla migrationer | `test/schema.test.ts` |
| 5 team + dedikerad sekvens, aldrig MAX+1 | `migrations/0001`–`0002`, `src/services/team.ts`, `skapaArende` | `test/sekvens-race.test.ts` |
| 6 workflow_states + seed | `migrations/0002`, `STANDARD_STATES` | `test/actions.test.ts` |
| 7 projekt/labels/issues/comments | `migrations/0003_arenden.sql` | `test/actions.test.ts`, `test/import.test.ts` |
| 8 append-only events, proveniens i samma tx | `migrations/0004_events.sql`, `src/actions/execute.ts` | `test/proveniens.test.ts` |
| 9 tsvector + GIN | `migrations/0005_sok.sql` | `test/sok.test.ts`, `test/schema.test.ts` |
| 10 api_keys + bearer, aktör ur nyckeln | `migrations/0006`, `src/http/middleware/autentisera.ts` | `test/proveniens.test.ts` |
| 11 samtliga actions | `src/actions/registry.ts` | `test/actions.test.ts`, `test/sok.test.ts` |
| 12 claim_next_issue, SKIP LOCKED | `claimaNastaArende` i `src/services/arenden.ts` | `test/claim-race.test.ts` |
| 13 express/helmet/rate-limit, 127.0.0.1:3002 | `src/http/app.ts`, `src/server.ts` | `test/actions.test.ts`, `test/ratelimit.test.ts` |
| 14 import av arkivet | `src/import/parsaArkiv.ts`, `src/import/importeraArkiv.ts` | `test/import.test.ts` |
| 15 LOC-numrering bevarad + setval | `importeraArende`, `sattSekvens` | `test/import.test.ts` |
| 16 idempotent via source_ref | `ON CONFLICT` i `importeraArende`/`laggTillKommentar` | `test/import.test.ts` |
| 17 TS-adapter | `src/adapter/index.ts` | — (bibliotek, kopplas in i Etapp 2) |
| 18 Python-klient | `adapter/arenden_klient.py` | — (bibliotek, kopplas in i Etapp 2) |
| 19 testrigg | `vitest.config.ts`, `test/env.ts` (`=`, aldrig `??=`), `test/globalSetup.ts`, `test/setup.ts` | hela sviten |
| 20 obligatoriska testfall a–e | — | `sekvens-race` · `claim-race` · `proveniens` · `sok` · `import` |

### Etapp 2a — krav → kod och test

Spec: [`docs/KRAVSPEC-ETAPP-2A.md`](docs/KRAVSPEC-ETAPP-2A.md). Allt nedan i
`test/vy.test.ts` går genom hela stacken med importfixturerna inlästa.

| Krav | Kod | Test |
| --- | --- | --- |
| ARKITEKTUR vy-router + mall, inga nya beroenden | `src/http/routes/vy.ts`, `src/http/vy/mall.ts`, `src/http/app.ts` (`app.use('/vy', …)` före nyckelkravet), `package.json` (oförändrade beroenden) | hela `test/vy.test.ts` |
| ARKITEKTUR ingen SQL i vylagret | routern anropar bara tjänstelagret; nya läsfrågor i `src/services/handelser.ts` (`listaSenasteHandelser`, `listaAktorer`, `arendenMedAktivitetAv`) och `src/services/arenden.ts` (`listaProjektnamn`, `listaEtikettnamn`) | `grep -nE 'SELECT .* FROM' src/http/routes/vy.ts src/http/vy/mall.ts` ger noll träffar |
| 1 överblick, gruppering, räknare | `vyRouter.get('/')` + `gruppera()` | "GET /vy ger 200, rubriken …" |
| 2 digest per dag och källa | `vyRouter.get('/digest')`, `listaSenasteHandelser` | "GET /vy/digest grupperar …" |
| 3 sök + fasetter som länkparametrar | `vyRouter.get('/sok')`, `sokLank()`, `fasettgrupp()`, `arendenMedAktivitetAv` | fyra `KRAV-3`-tester (fritext, ord bara i kommentar, utan q, aktörsfasett) |
| 4 ärendesida + 404 som HTML | `vyRouter.get('/arende/:identifier')`, `ickeFunnen()` | "GET /vy/arende/LOC-316 …", "okänt ärende ger 404 …" |
| 5 proveniens överallt (AI Act art. 50) | `proveniens()` i `src/http/vy/mall.ts` — enda sättet att skriva ut en aktör | "agent-rad bär agent-märkningen …" (verifierar även att INGEN rad är omärkt) |
| 6 escaping via en funktion | `esc()` i `src/http/vy/mall.ts` | "all dynamisk text escapas …" |
| 7 svenska, rubriken "Ärenden", inga Linear-länkar | hela vylagret | "GET /vy ger 200, rubriken …" |
| 8 säkerhetsmodellen oförändrad, tailscale-kommando dokumenterat | `src/http/app.ts`, `src/config.ts` (bind 127.0.0.1), README ovan | "/vy svarar utan nyckel medan skrivande /api utan nyckel ger 401" |
| 9 `npm run check` | `package.json` | — (kommandot självt) |
| 10 a–f | — | `test/vy.test.ts` |

### Dokumentlänkar — krav → kod och test

Spec: [`docs/KRAVSPEC-DOKUMENTLANKAR.md`](docs/KRAVSPEC-DOKUMENTLANKAR.md). Allt
nedan i `test/dokumentlankar.test.ts`, genom hela stacken mot en testvault
(`VAULT_PATH` → `$TMPDIR/arenden-test-vault`, satt i `test/env.ts`).

| Krav | Kod | Test |
| --- | --- | --- |
| ARKITEKTUR vylagret, inga nya beroenden | `vyRouter.get('/dok/*sokvag')` i `src/http/routes/vy.ts`, `src/http/vy/markdown.ts` (samma `esc()`/`sida()`), `package.json` (oförändrade beroenden) | hela `test/dokumentlankar.test.ts` |
| ARKITEKTUR filnamnsindex, asynkront vid start | `hamtaIndex()`/`startaIndexbygge()` i `src/http/vy/dokument.ts`, anropad i `src/server.ts` | "alla fyra referensmönstren blir länkar …" (indexberoende (b)/(d)) |
| 1 dokumentsida + enkel markdown + Obsidian-länk | `renderaMarkdown()`, `/dok/*sokvag` | "vitlistat dokument renderas …", "obsidian-länken är korrekt URL-enkodad …" |
| 2 vitlista, path traversal, realpath | `VITLISTA`, `sakerSokvag()`, `lasDokument()` i `src/http/vy/dokument.ts`, `utanforOmradet()` i routern | "allt utanför vitlistan ger 404 utan innehåll eller katalognamn" (jag.md, journal/, hälsa/, 05-Dagligt/, `..`, symlink ut, saknad fil) |
| 3 autolänkning a–d i renderingssteget | `autolanka()` i `src/http/vy/markdown.ts`, anropad på `a.description` och `k.body` i ärendesidan | "alla fyra referensmönstren …", "tvetydigt filnamn och ej vitlistad referens förblir ren text" |
| 4 LOC-N → `/vy/arende/LOC-N` | samma tokenisering i `markdown.ts` | "LOC-N blir intern länk, i både beskrivning och kommentar" |
| 5 cache med TTL, en fil per request | TTL i `dokument.ts`; routern gör `hamtaIndex()` + EN `lasDokument()` | — (invariant i koden; ingen sökning per request) |
| 6 a–e | — | `test/dokumentlankar.test.ts` |

### K-1 — rättningsvägar och skrivvägen i vyn (Davids beslut #64)

Etapp 2a:s avgränsning *"ingen skrivfunktion från vyn (inga POST-rutter under
`/vy`)"* är **medvetet upphävd**, och bara den. Läsning kräver fortfarande ingen
nyckel; skrivning kräver en session, och en session kan bara födas ur en giltig
API-nyckel. Aktören härleds alltså ur en nyckel även i webbläsaren — precis som
på `/api` (KRAV-10).

Principen i rättigheterna: **rätta får man, radera historik får man inte.**
`events` är oförändrad — ingen ny rättighet, ingen ny trigger, ingen ny väg in.

| Vad | Hur | Kod | Test |
| --- | --- | --- | --- |
| Kommentarstext | UPDATE (mjuk historik: gamla texten i händelseraden) | `rattaKommentar`, action `update_comment` | "en kommentar går att rätta …" |
| Kommentar bort | MJUK radering (`comments.borttagen`), går att ångra | `taBortKommentar`/`aterstallKommentar`, `delete_comment`/`restore_comment` | "mjuk borttagning: borta ur vy, sök och aktörsfasett …" |
| Etikett på ärende | HÅRD DELETE på `issue_labels` (kopplingsrad utan eget innehåll) | `taBortEtikettFranArende`, `remove_label` | "en etikett går att ta bort …" |
| Projekt-/etikettnamn | UPDATE endast på `namn` — DELETE ges aldrig | `dopOmProjekt`/`dopOmEtikett`, `rename_project`/`rename_label` | "ett felstavat etikettnamn …", "ett projektnamn …" |
| Nyckel | `aktiv = false` — aldrig DELETE | `aterkallaNyckel`, `revoke_api_key` | "en nyckel går att återkalla …" |
| Proveniens (`aktor_typ`/`aktor_namn`) | **Går inte att ändra.** Kolumn-GRANT (42501) för app-rollen OCH trigger (P0001) för ägaren — två oberoende linjer, som för `events` | `migrations/0011_rattelser.sql` | "app-rollen får 42501 …", "ÄGARROLLEN får P0001 …" |
| Aktör för vyskrivningar | Session ur API-nyckel, kaka HttpOnly + SameSite=Strict + Path=/vy | `src/http/vy/session.ts` | "utan session skrivs ingenting …", "sessionskakan är HttpOnly …" |
| CSRF | `Sec-Fetch-Site` måste vara `same-origin` om satt + `Origin`-jämförelse (samma som `/opt/redovisning`) + SameSite=Strict | `kravSammaUrsprung` | "CSRF: främmande Origin …", "CSRF: Sec-Fetch-Site …" |
| JS-fritt | Formulär + POST + 303-redirect. CSP `script-src 'none'` (var helmets default `'self'` före K-1) | `src/http/vy/skrivning.ts`, `src/http/app.ts` | "vyn är JS-fri och CSP:n förbjuder skript" |
| Nyckelutfärdning | Ansluter som `app` (inte ägaren) och skriver `skapade_aktorsidentitet` i samma transaktion. Nyckeln går till en 0600-fil, aldrig till stdout | `src/scripts/skapaNyckel.ts` | "npm run nyckel: skapar som app-rollen …" |

```bash
# Utfärda en människonyckel. Nyckeln skrivs ALDRIG i terminalen.
npm run nyckel -- manniska "David Mancilla"
# → skriver /home/hermes/.arenden/nycklar/<...>.nyckel (0600) och visar sökvägen.
#   Läs den en gång och radera: cat '<fil>' && shred -u '<fil>'
# Logga in i vyn med den på /vy/logga-in. Rättelser: /vy/rattelser
```

### K-9 — egen ingång per system

Davids krav: **alla tre system ska kunna leva helt oberoende av varandra vid
behov.** Redovisningens dashboard (3001) är redovisningens. Hermes-ytan (8650)
har rummen och portföljen. Ärendeplattformen (3002) hade fem läsrutter och
ingen som svarade på *"vad ligger på mig"*. En delad dashboard vore en tionde
bindning och byggdes **inte** — plattformen fick sin egen ingång i stället.

`GET /vy/mitt` läser **enbart** den här plattformens databas. Inget uppslag mot
3001 eller 8650, inte ens en länk. Sidan svarar likadant när de är nere.

Det som **inte** finns, och som sidan därför säger rakt ut: `issues` har inget
ansvarigfält. `claimad_av` är agentköns och är NULL på samtliga 339 ärenden. En
"mina ärenden"-sida byggd på den kolumnen hade renderat en tom sida, och en tom
sida läses som *"inget ligger på dig"*. Varje hög är i stället ett påstående om
ett **fält** eller om **ordningen i händelseloggen**, och regeln står utskriven
under rubriken.

| Hög | Regel | Mätt 2026-08-26 |
| --- | --- | --- |
| Någon annan skrev sist | Öppet, du har ett spår, senaste spåret är någon annans | 1 |
| Du skrev sist | Öppet, senaste spåret är ditt | 36 |
| Plockat av dig | `claimad_av` = ditt namn | 0 av 339 — kön används inte |
| Deadline passerad/inom 7 d | `due_date <= idag+7`. **Gäller alla** | 21 (9 passerade) |
| Ingen har rört dem | Inget spår alls från människa eller agent | 112 av 177 öppna |

Importens och återläsningens systemrader räknas **inte** som spår. Gjorde de
det vore "någon annan skrev sist" sant om 143 av 177 öppna ärenden, och högen
hade betytt "återläsningen kördes i natt".

Skiftläge viks ihop vid läsning: nyckeln bär `David Mancilla`, kommentarernas
proveniens bär `david mancilla`. En skiftlägeskänslig jämförelse gav noll
träffar och såg ut som ett tomt läge. Proveniensen är oföränderlig (0011), så
namnen kan inte slås ihop i efterhand — de viks ihop vid läsning, och **att de
viks ihop står på sidan**.

### K-10 — tre vägar förbi händelseloggen

`events` är append-only och proveniensen oföränderlig. Tre vägar gick ändå
förbi loggen. Alla tre är stängda **framåt**; ingenting är backfyllt.

| Väg | Vad som hände | Vad som gjordes |
| --- | --- | --- |
| 1. `arendehem.py` | Körde `update issues set project_id = ...` med psql som superuser. 17 ärenden i placeringsloggen har fått sitt `project_id` den vägen, och **ingen** av 838 händelserader säger att ett ärende bytt projekt | `projekt` är nu ett fält som alla andra i `update_issue`; verbet är `andrade_projekt`. Skriptet anropar API:t med agentnyckeln — aktören ur nyckeln, aldrig superuser |
| 2. `skapaNyckel.ts` | Mintade nycklar utan händelse | **Redan löst i K-1** (78293f7). Verifierat, inte ombyggt: de två nycklarna från 18–19 aug saknar rad, de två från 26 aug har sin |
| 3. Importen | 186 av 207 kommentarer saknar händelserad. De kom in via `importeraArkiv` | Importen skriver `importerade_kommentar` per **ny** kommentar. Omkörningen är fortfarande idempotent (KRAV-16) — nu även i `events` |

Projektet måste **finnas**: `sokProjekt` slår upp utan att skapa, och ett okänt
namn ger 404. Fick vägen skapa projekt hade ett stavfel i en titeltagg blivit en
ny rad i registret i stället för ett fel.

**"Varför".** Ingen payload bar ett skäl. `update_issue` tar nu ett frivilligt
`skal` som följer med i händelseraden och renderas i digesten och på
ärendesidan. Frivilligt med flit: ett obligatoriskt skäl hade fyllts med
"uppdatering" inom en vecka. `arendehem.py` skickar ordagrant det bevis
`bedom()` placerade på — inte ett skäl formulerat i efterhand.

**Ingen backfyllning.** De 186 kommentarerna utan rad är ett faktum om det
förflutna. `~/.hermes/prov/handelsevag.py` låser talet vid exakt 186 i **båda**
riktningarna: växer det har en ny kommentar kommit in förbi skrivvägen, krymper
det har någon backfyllt händelser som aldrig hände.

## Gränser för Etapp 2a

Ingen skrivfunktion från vyn (inga POST-rutter under `/vy`), ingen auth-UI, inga
notiser, ingen cutover. Ingen templatemotor och inga nya beroenden — express +
template literals. Ingen klient-JS. Ingen SQL i vylagret. Ingen exponering
utanför `127.0.0.1` (tailscale serve är dokumenterat men **inte kört**).

## Gränser för Etapp 1

Ingen vy/UI (den kom i Etapp 2a), inga notiser, ingen MCP-server, inga RLS-policyer (bara
`tenant_id`-kolumnen), inga cycles/estimates/roadmaps. Inga beroenden utanför
stacklistan i kravspecen.
