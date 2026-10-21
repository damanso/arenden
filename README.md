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
| `GET /vy/sok?q=...` | **Sök** — fritext över titel, beskrivning och kommentarer + fasetter `?status=&etikett=&projekt=&aktor=`; ett ärendenummer (`LOC-503`, `loc 503`, `503`) öppnar ärendet direkt (D-1) |
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
| Samtidiga rättelser | Radlås före läsningen av det gamla värdet; den som kommer tvåa läser det den första committade (B-01) | `hamtaArendeForAndring` (`uppdateraArendeFalt`), `hamtaKommentarForAndring` (`rattaKommentar`, `taBortKommentar`, `aterstallKommentar`, `update_comment`, `delete_comment`) | `test/samtidighet.test.ts` |
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

### FR-4 — varje mutation via actions, aktören ur nyckeln (Story 1.3 och 1.4)

En mutation från `/api` eller vyn går bara genom `executeAction`. Aktören kommer ur en nyckel —
bearer, eller en vysession som fötts ur en nyckel — och aldrig ur indata. Ett undantag finns i dag:
redovisningssessionen. `sessionsAktor` (`src/http/vy/session.ts`) tar först `req.redovisningsaktor`,
en människoaktör ur redovisningens inloggning som inte kommer ur någon nyckel och inte behöver finnas
i `api_keys`. Undantaget ägs av Story 3.4 (B-03) och står utanför provet. En write-action som inte
skriver någon händelserad rullas tillbaka. Transportlagret (`src/http/`) innehåller ingen
SQL-skrivsats. `events` och `comments` skrivs bara av `skrivHandelse` och `laggTillKommentar`, och
provet håller listan över de filer som når dem sluten för de former det läser i källtexten: statiska
importer och återexporter (namngivna, med alias, hela modulen), dynamiska importer med fast sökväg,
och i en fil som binder namnet varje alias och varje förekomst som inte är ett direkt anrop. I vyn
prövar det att varje `kor()` tar skrivruttens aktör ur `kravSessionsAktor(req)`. En importsökväg som
byggs först vid körning ser provet inte; där gäller lagerregeln och granskningen.

**Skrivvägarna förbi nyckelhärledningen är en sluten lista** (Davids beslut 2026-10-16 11:00, svar på
kodgranskningens fråga 1; Story 1.4): migrationerna, nyckelskriptet `src/scripts/skapaNyckel.ts`,
importen och återläsningen. Redovisningssessionen ovan hör inte till listan: den är en känd avvikelse
som Story 3.4 tar bort (B-03). Ett tomt system kan inte autentisera sitt första nyckelutfärdande med en
nyckel som ännu inte finns, och importen och återläsningen är operatörsverktyg på värden. De tre som
skriver data bär var sin fasta systemaktör och skriver händelseraden i samma transaktion som raden den
gäller; migrationerna skriver aldrig rader i `events` eller `comments`. Inget nytt skrivande verktyg
får läggas till utanför `executeAction`, och allt nytt — även onboardingen (Story 9.4) — skriver via
API:t med en nyckel. En kommentar som importen förde in bär arkivets författare, som ärendesidan visar
(FR-12). Mutationens aktör, `system · linear-import`, står på händelseraden `importerade_kommentar`
som namnger kommentaren — för kommentarer som importerats sedan K-10; de 186 äldre saknar raden och
backfylls inte (K-10 ovan).

| Krav | Mekanism | Kod | Test |
| --- | --- | --- | --- |
| FR-4 | `autentisera` före varje `/api`-rutt (401 före valideringen); aktören ur `kravAktor(req)` på `/api` och ur `kravSessionsAktor(req)` genom `skrivrutt()` och `kor()` i vyn; `.strict()` på varje schema; räknaren i `executeAction` rullar tillbaka en write-action utan händelserad; `events` append-only (GRANT och triggrar); skrivställena för `events` och `comments` är en sluten lista; de fyra slutna undantagen nedan bär fasta systemaktörer (Davids beslut 2026-10-16 11:00) | `src/http/app.ts`, `src/http/middleware/autentisera.ts`, `src/http/routes/actions.ts`, `src/http/vy/skrivning.ts` (`skrivrutt`, `kor`), `src/http/vy/session.ts`, `src/actions/execute.ts`, `src/actions/registry.ts`, `src/services/handelser.ts`, `src/services/kommentarer.ts`, `migrations/0004_events.sql` | `test/skrivvagar.test.ts` (AK 1–4; AK 5: invarianten över API:t och vyn; AK 6: inga skrivsatser i transportlagret; Story 1.4 AK 1: verktygens fasta aktörer i samma transaktion; Story 1.4 AK 3: invarianten över alla vägar), `test/proveniens.test.ts` (KRAV-8/10/20c) |
| FR-4, undantag: migrationerna | ingen aktör: schema, ledgern (`schema_migrations`) och migrationskedjans egna grundrader och backfyllningar, aldrig rader i `events` eller `comments`; Davids beslut 2026-10-16 11:00 | `src/db/migrate.ts`, `migrations/` | `test/skrivvagar.test.ts` (Story 1.4 AK 1) |
| FR-4, undantag: nyckelskriptet (`npm run nyckel`) | fast aktör `system · skapa-nyckel`; `skapade_aktorsidentitet` i samma transaktion som `api_keys`-raden; Davids beslut 2026-10-16 11:00 | `src/scripts/skapaNyckel.ts` | `test/skrivvagar.test.ts` (Story 1.4 AK 1 och AK 3), `test/rattelser.test.ts` |
| FR-4, undantag: importen (`npm run import`) | fast aktör `system · linear-import`; `importerade_arende` och `importerade_kommentar` i samma transaktion som ärendet och kommentaren; Davids beslut 2026-10-16 11:00 | `src/import/importeraArkiv.ts` | `test/skrivvagar.test.ts` (Story 1.4 AK 1 och AK 3), `test/import.test.ts` |
| FR-4, undantag: återläsningen (`npm run aterlas`) | fast aktör `system · linear-aterlasning`, genom `executeAction`: varje write-action skriver sin händelserad i samma transaktion; Davids beslut 2026-10-16 11:00 | `src/import/aterlasLinear.ts` | `test/skrivvagar.test.ts` (Story 1.4 AK 1 och AK 3), `test/aterlasning.test.ts` |

### FR-16 — åtagandehändelserna bär skäl och revision (Story 5.2)

Tre regler gäller (B-07, Story 5.2). De står ordagrant som i regelkällan:

- Åtagandets händelser skrivs bara genom `skrivAtagandeHandelse` i `src/actions/registry.ts`, som lägger `identifier` och åtagandets `revision` efter åtgärden sist i payloaden. Det gäller verben `registrerade_atagande`, `atagandet_fanns_redan`, `tog_over_atagande`, `andrade_atagande`, `hindrade_atagande`, `redovisade_resultat`, `avslutade_atagande` och `aterppnade_atagande` (FR-16 delkrav 6, B-07; Story 5.2). Varje uppdatering bär sitt skäl ur handlingens egen motivering:
  - registrering: `grund`;
  - övertagande: `nasta.grund`, i fältet `grund`;
  - ändring: `grund`, annars `nasta.grund`, annars ett obligatoriskt `skal` (`skal_saknas`, som prövas sist);
  - hinder: `orsak` och `belagg`;
  - resultat: `sammanfattning`, hela `belagg` och `kontrollerat`;
  - avslut: `skal` och `grund`;
  - återöppning: `grund` och `tidigare: { resultat, avslutsskal }`.

  Befintliga payloadfält tas aldrig bort.
- Varje uppdatering av ett åtagande, det vill säga de sju verben utom `atagandet_fanns_redan`, bär `andring`: de av åtagandets fält som åtgärden ändrade, vart och ett som `{ fran, till }`. Tjänstelagret räknar den på ett ställe, i `skrivOchJamfor` i `src/services/atagande.ts`, som är den enda som anropar `skriv`. Jämförelsen går mellan det låsta radläget före och omläsningen efter, över åtagandets hela, slutna fältlista: `lage`, `tillhor`, `utforare_typ`, `utforare_namn`, `overtaget_nar`, `foljs_upp`, `grund`, `nasta`, `villkor`, `utfall_precisering`, `hinder`, `resultat` och `avslutsskal`. tsc fäller bygget om en nyckel i `AtagandeJson` eller en `atagande_`-kolumn saknas i listan, och `skrivAtagandeHandelse` tar inte ett uppdateringsverb utan `andring`. Ett fält som åtgärden tar bort eller nollställer står därför med sitt gamla värde i `fran` och `null` i `till`, och registreringen bär varje registrerat värde med `fran: null` (FR-16 delkrav 6, B-07; Story 5.2 AK 12). Rader som skrevs innan regeln byggdes saknar fältet, utom `andrade_atagande`, och inget fylls i efterhand.
- Varje åtgärd som ändrar ett befintligt åtagande kräver `forvantad_revision` och prövar den med `kravRevision` direkt efter `kravAtagande`, före varje annan regel. Utan fältet blir svaret 400 `revision_saknas` och med en annan revision 400 `gammal_revision` (B-07; Story 5.2). I schemat är fältet `.optional()` med flit, så att felet får sin egen kod och plats. Ett nytt prov eller anrop som ändrar ett åtagande skickar alltid fältet, och ett `andra_atagande` utan `grund` och `nasta` skickar `skal`, utom de avvisade anrop som prövar just den regeln.

| Krav | Mekanism | Kod | Test |
| --- | --- | --- | --- |
| FR-16 delkrav 6, revisionskontroll | `kravRevision` direkt efter `kravAtagande` i de sex tjänstefunktionerna; `forvantad_revision` är valfritt i schemat men obligatoriskt i tjänsten, så att felet får egen kod och plats i ordningen | `src/services/atagande.ts`, `src/actions/registry.ts` | `test/atagande-handelser.test.ts` (AK 5–7), `test/atagande.test.ts` |
| FR-16 delkrav 6, skäl och revision på raden | `skrivAtagandeHandelse` är den enda vägen för de åtta åtagandeverben och lägger `identifier` och `revision` sist; `skal_saknas` i `andraAtagande` | `src/actions/registry.ts`, `src/services/atagande.ts` | `test/atagande-handelser.test.ts` (AK 1, AK 3, AK 8) |
| FR-16 delkrav 6, ändringen på raden | `skrivOchJamfor` är den enda som anropar `skriv` och ger `andringMellan` mellan det låsta radläget och omläsningen, över den slutna fältlistan som tsc håller hel; `skrivAtagandeHandelse` kräver `andring` för varje uppdateringsverb | `src/services/atagande.ts`, `src/actions/registry.ts` | `test/atagande-handelser.test.ts` (AK 2, AK 12) |
| FR-16 delkrav 3, återöppningen | `aterppnaAtagande` kräver revision och bär `tidigare` ur det låsta radläget; `events` är append-only | `src/services/atagande.ts`, `src/actions/registry.ts`, `migrations/0004_events.sql` | `test/atagande-handelser.test.ts` (AK 4) |

### D-1 — sökningen öppnar ärendet på sitt nummer (Story 11.1)

Ärendets nummer lagras aldrig: `identifier` härleds ur teamets nyckel och `sequence_number`, så numret
finns inte i sökindexet. `/vy/sok` tolkar därför `q` som ett ärendenummer före fritexten (B-20).
Tolkningen är den rena funktionen `tolkaArendenummer()` i `src/lib/validation.ts`, och den känner igen en
sluten lista skrivsätt: teamnyckeln följd av bindestreck, hårt bindestreck, tankstreck, långt tankstreck
eller minustecken (U+2011, U+2013, U+2014, U+2212), av blanksteg eller av ingen avskiljare alls; gemener
och versaler; inledande nollor; och bart nummer med eller utan `#`. Ett nummer över 2 147 483 647 kan
inte finnas och slås aldrig upp. `hittaArendenMedNummer()` i `src/services/arenden.ts` slår upp
sökningens nummer i en enda fråga på `(team, sequence_number)`. Sökningen svarar i fyra lägen: ett nummer
med en träff ger 303 till ärendet, samma nummer i flera team ger en lista, ett nummer utan träff ger
«Inget ärende har numret …» med fritextträffarna för samma sträng under, och en längre sökning visar
numren överst och fritexten som förut. `search_issues` och fritextens rangordning är oförändrade, och
API:ts nummeruppslag är `get_issue`.

| Krav | Mekanism | Kod | Test |
| --- | --- | --- | --- |
| D-1 | `tolkaArendenummer()` är ren och tolkar en sluten lista skrivsätt; `MAX_ARENDENUMMER` gäller i tolkningen och i tjänstelagret; ett enda uppslag med `= ANY($2::int[])`; omdirigeringen bara när hela sökningen är ett nummer med exakt en träff | `src/lib/validation.ts`, `src/services/arenden.ts`, `src/http/routes/vy.ts` | `test/sok-nummer.test.ts` (AK 1–7) |
| FR-2, FR-11 (regression) | en sökning utan nummer går fritextvägen som förut; `sokArenden`, `listaArenden`, fasetterna och `search_issues` är orörda | oförändrade | `test/sok.test.ts`, `test/vy.test.ts` (KRAV-3), `test/sok-nummer.test.ts` (F18) |

### FR-37 — svenska felbesked i vyn (Story 2.2)

Vyns felsidor säger på svenska vad som hände och varför (B-14). Ett `AppError` utom `UnauthenticatedError` i skrivramen `skrivrutt()` eller i in- och utloggningens ursprungskontroll `ursprungOk()` blir felsida genom `felbesked()`, som slår upp koden i den slutna tabellen `FELBESKED` i `src/http/vy/skrivning.ts`: `atagandet_styr_statusen` ger 400 och «Tillståndet följer åtagandet» med ärendets nummer och en länk tillbaka, `kraver_manniska` ger 403 och «Det här kräver en människa», och `cross_origin` ger 403 och «Gick inte att utföra». En kod som inte står i tabellen ger «Gick inte att utföra» och tjänstens meddelande som förut, eller en fast mening när meddelandet bara är koden. Statusen är felets egen, som på `/api`. Felkoden står bara i ett `code`-element efter meningen. Ett valideringsfel ger «Ogiltig inmatning» med fältets svenska namn ur `FALTNAMN` och en fast mening; zods egna meddelanden läses aldrig. 401-sidan «Inloggning krävs» är oförändrad. Felsidorna visar ingen aktör i hörnet. API:ts JSON-svar är oförändrade.

Regeln står ordagrant som i regelkällan:

- Vyns felsidor (B-14, Story 2.2): ett `AppError` utom `UnauthenticatedError` i `skrivrutt()` eller `ursprungOk()` blir felsida bara genom `svaraMedFelbesked()` och den slutna felkodstabellen `FELBESKED` i `src/http/vy/skrivning.ts`, som ger svensk rubrik och mening. En ny felkod som ytan kan möta läggs i tabellen. En kod som inte står där visar tjänstens meddelande, eller en fast mening när meddelandet bara är koden, och felkoden står bara i ett `code`-element efter meningen, aldrig ensam. Ett valideringsfel visar fältets namn ur `FALTNAMN` och en fast mening, och zods `message` läses aldrig i vylagret. Felsidor anropar `sida()` utan aktör, så hörnet är tyst. Statusen är felets egen, som på `/api`.

| Krav | Mekanism | Kod | Test |
| --- | --- | --- | --- |
| FR-37, FR-14, FR-32 (felbeskeden) | `felbesked()` är den enda vägen från ett `AppError` utom `UnauthenticatedError` till en felsida i vyn och läser den slutna tabellen `FELBESKED`; okänd kod ger tjänstens meddelande; koden står bara i `code` efter meningen | `src/http/vy/skrivning.ts` (`skrivrutt`, `ursprungOk`, `svaraMedFelbesked`, `felbesked`, `felsida`) | `test/felbesked-yta.test.ts` (AK 1, AK 2, AK 5) |
| FR-37 (valideringsfel) | `ogiltigInmatning()` läser aldrig zods meddelande; fältnamnet ur `FALTNAMN`, meningen ur tre fasta mallar | `src/http/vy/skrivning.ts` (`ogiltigInmatning`, `FALTNAMN`) | `test/felbesked-yta.test.ts` (AK 3, AK 5) |
| FR-37 (felsidornas form) | `felsida()` ger `h1`, en `p.notis`, vägen tillbaka och ett tyst hörn; all text genom `esc()` | `src/http/vy/skrivning.ts` (`felsida`) | `test/felbesked-yta.test.ts` (AK 4) |

### FR-34 — en escape-funktion, också för menyns adresser (Story 2.4)

All dynamisk text i vyn går genom `esc()` i `src/http/vy/mall.ts`, den enda HTML-escapefunktionen under `src/http/` (FR-34, KRAV-6). Det gäller också produktmenyns fyra adresser, gruppens rubrik, panelens länkar, området och snabbraden. De kommer ur navigationskontraktet genom `modell()` i `src/http/vy/navigation.ts`, och `produktmeny()` skriver dem genom `esc()` (B-15). Med dagens kontrakt ändrar `esc()` ingen adress, så menyn är densamma. Provet `test/escape-yta.test.ts` läser varje fil under `src/http/`. Det fäller ett `href`- eller `action`-värde vars dynamiska del inte börjar med `esc(`, ett sådant attribut utan dubbla citattecken och ett värde som inte slutar på sin rad. En adress ur data skrivs `esc(sakerUrl(…))`, och ett värde som bara går genom `sakerUrl()` fälls. Undantagen är en sluten lista med skäl: de två fragmenten i `src/http/vy/markdown.ts` som byggs ur text som redan gått genom `esc()`. Andra skrivsätt för ett attribut läser provet inte. Där gäller regeln och granskningen.

Regeln står ordagrant som i regelkällan:

- Adresser i vyn (FR-34, B-15, Story 2.4): `esc()` i `src/http/vy/mall.ts` är den enda HTML-escapefunktionen under `src/http/`. Varje dynamisk del av ett `href`- eller `action`-värde, i en mall eller i en sammanfogning, börjar med `esc(`, också för adresser ur `kontrakt/navigation.v1.json`. En adress ur data går genom `sakerUrl()` inuti `esc()`, som `esc(sakerUrl(…))`. Värdet står inom dubbla citattecken och på samma rad som attributet. Ett fragment som redan gått genom `esc()` står i undantagslistan `UNDANTAG` i `test/escape-yta.test.ts` med fil, uttryck och skäl, och listan är sluten.

| Krav | Mekanism | Kod | Test |
| --- | --- | --- | --- |
| FR-34 (menyns adresser) | `produktmeny()` skriver gruppens rubrik, panelens länkar, området och snabbraden genom `esc()`; modellen är en parameter, så provet kan ge farliga adresser | `src/http/vy/mall.ts` (`produktmeny`) | `test/escape-yta.test.ts` (AK 1) |
| FR-34 (en escape-funktion) | `esc()` är den enda HTML-escapefunktionen och importeras ur `mall.ts`; varje dynamisk del av ett `href`- eller `action`-värde börjar med `esc(`, med `sakerUrl()` inuti för adresser ur data, utom den slutna listan `UNDANTAG` | `src/http/vy/mall.ts`, `src/http/vy/skrivning.ts`, `src/http/routes/vy.ts` | `test/escape-yta.test.ts` (AK 2) |
| FR-34, KRAV-6 (regression) | ärendetexten escapas före markdown och autolänkar (`renderaArendetext()`), annan text genom `esc()`; CSP:n `script-src 'none'` är den yttre spärren | `src/http/routes/vy.ts`, `src/http/vy/markdown.ts`, `src/http/app.ts` | `test/escape-yta.test.ts` (AK 3), `test/vy.test.ts` (KRAV-6) |

### FR-32 — tillståndsrutten står i adresskontraktet (Story 2.6)

Tjänstens rutter står i navigationskontraktets kopia `kontrakt/navigation.v1.json`, som genereras i valvet och aldrig redigeras här (`kontrakt/README.md`). Provet `test/adresskontrakt.test.ts` jämför kopians rutter för tjänsten arenden med de rutter som appen registrerar, åt båda hållen: varje rutt i `vyRouter` (under `/vy`), i `actionsRouter` (under `/api`) och direkt på appen står i kopian med samma metod, routermönster och publika adress, och varje rutt för tjänsten i kopian finns i koden. Monteringarna är en sluten lista i provet, och en router som monteras utan att stå där fäller det. Undantaget är den slutna listan `VANTANDE`, med rutter som kopian får bära innan de byggs. I dag står där `POST /vy/arende/:identifier/tillstand` (FR-32, B-04), som generatorn för in och Story 3.3 bygger. Posten har samma kategori, ägare och verifiering som `POST /vy/arende/:identifier/ratta`. Provet fäller den när den bär andra fält och när rutten är byggd men posten står kvar, och det fäller en rutt som byggs utan att stå i kopian. Menyn läser aldrig kontraktets rutter: `modell()` i `src/http/vy/navigation.ts` tar kopian som parameter, och provet visar att samma kopia med och utan rutter ger samma meny (FR-15). Andra tjänsters rutter och de tre kopiornas likhet prövar provet adresskontraktet i provvakten, inte det här provet. En rutt för alla metoder (`router.all()`) kan kontraktet inte bära, och provet fäller den. En underapp ur `express()`, en router som monteras inlindad i en funktion och en hanterare som svarar utan att vara en rutt, som JSON-404:an, ser provet inte. Där gäller regeln, granskningen och provet adresskontraktet i drift.

Regeln står ordagrant som i regelkällan:

- Rutter och adresskontraktet (FR-32, FR-15, Story 2.6): varje rutt som tjänsten registrerar, i `vyRouter` under `/vy`, i `actionsRouter` under `/api` och direkt på appen, står i `kontrakt/navigation.v1.json` med samma metod, routermönster och publika adress, och varje rutt för tjänsten arenden i kopian registreras i koden, utom posterna i den slutna listan `VANTANDE` i `test/adresskontrakt.test.ts`. En ny rutt kommer in i kopian bara genom generatorn i valvet, aldrig för hand, och före koden: berättelsen som förbereder kontraktet lägger posten i `VANTANDE`, och berättelsen som bygger rutten tar bort den i samma diff. En ny router monteras bara med en post i provets lista `montering()`. `modell()` läser aldrig kontraktets rutter.

| Krav | Mekanism | Kod | Test |
| --- | --- | --- | --- |
| FR-32, FR-15 (rutterna i kopian) | `ruttfel()` jämför kopians rutter för tjänsten arenden med rutterna i `vyRouter`, `actionsRouter` och på appen, åt båda hållen och med publik adress; monteringarna är en sluten lista | `src/http/app.ts`, `src/http/routes/vy.ts`, `src/http/vy/skrivning.ts`, `src/http/routes/actions.ts`, `kontrakt/navigation.v1.json` (genererad) | `test/adresskontrakt.test.ts` (AK 1, AK 2) |
| FR-32 (tillståndsrutten före koden) | den slutna listan `VANTANDE` med `POST /vy/arende/:identifier/tillstand`, med samma kategori, ägare och verifiering som `POST /vy/arende/:identifier/ratta`; en byggd rutt måste lämna listan | `kontrakt/navigation.v1.json` (genererad i valvet) | `test/adresskontrakt.test.ts` (AK 1) |
| FR-32, FR-15 (menyn oförändrad) | `modell()` tar kopian som parameter och läser bara grupper, destinationer och ytor, aldrig rutter | `src/http/vy/navigation.ts` (`modell`) | `test/adresskontrakt.test.ts` (AK 2) |

### FR-37 — statusord och händelseverb på svenska (Story 2.1)

Ytan visar tillstånd och händelser på svenska (B-14). De lagrade tillståndsnamnen är Linears (`STANDARD_STATES` i `src/services/team.ts`) och står kvar i databasen, eftersom händelserna är append-only och importen mappar arkivets namn rakt av. Vyn översätter dem vid visning genom tabellen `STATUSORD` i `src/http/vy/mall.ts`, med en rad per typ: Backlog blir Ej planerat, Todo blir Att göra, In Progress blir Pågår, Done blir Klart och Canceled blir Avbrutet. `statuschip()` översätter det lagrade namnet och tar klassen ur typen, och summeringsraden på `/vy`, statusfasetten och raden Aktiva filter på `/vy/sok` tar ordet för typen ur samma rad. Historikens rad för `andrade_status` översätts på samma sätt, och bara den, eftersom andra verbs värden är titlar och namn. Ett namn som inte står i tabellen visas som det är lagrat. Sökträffarna i vyn läser det lagrade namnet genom `sokArendenIVy()` i `src/services/arenden.ts`, och `search_issues` svarar med samma sex fält som förut. Varje verb som koden skriver har en svensk text i `VERB`. Provet läser verben ur källkoden, i de filer som väljer ett verb åt händelseloggen, och fäller ett verb utan text med verbets namn.

Regeln står ordagrant som i regelkällan:

- Statusord och händelseverb i vyn (FR-37, B-14, Story 2.1): ett tillstånd visas i vyn bara genom tabellen `STATUSORD` i `src/http/vy/mall.ts`, som har en rad per typ och översätter de fem standardnamnen: Backlog blir Ej planerat, Todo blir Att göra, In Progress blir Pågår, Done blir Klart och Canceled blir Avbrutet. Ett lagrat namn visas genom `statusord()` och en typ genom `statusordForTyp()`, som läser samma rad. Ett namn som inte står i tabellen visas som det är lagrat, och chippets klass kommer ur typen. Översättningen sker bara vid visning, och `workflow_states.namn` och händelsernas payload ändras aldrig för den. Varje verb som koden skriver har en svensk visningstext i `VERB` i samma fil, och den som inför ett nytt verb skriver texten i samma diff. Provet `test/svenska-yta.test.ts` läser verben ur källkoden i en sluten lista filer och skrivsätt och fäller ett verb utan text. Ett nytt skrivsätt läggs i provets lista. `verbText()` slår upp texten med `Object.hasOwn()`, och reservvägen `verb.replace(/_/g, ' ')` står kvar som sista skydd.

| Krav | Mekanism | Kod | Test |
| --- | --- | --- | --- |
| FR-37 (statusord) | en tabell `STATUSORD` med en rad per typ; `statusord()` och `statusordForTyp()` läser samma rad; `statuschip()` översätter, och klassen kommer ur typen; ett okänt namn visas som det är lagrat | `src/http/vy/mall.ts` (`STATUSORD`, `statusord`, `statusordForTyp`, `statuschip`), `src/http/routes/vy.ts`, `src/services/arenden.ts` (`sokArendenIVy`) | `test/svenska-yta.test.ts` (AK 1, AK 2) |
| FR-37 (inga engelska standardnamn) | översättningen sker bara vid visning, och `STATE_TEXT` finns inte; databasens namn och händelsernas payload är oförändrade | `src/http/vy/mall.ts`, `src/http/routes/vy.ts` | `test/svenska-yta.test.ts` (AK 3, AK 4) |
| FR-37 (händelseverb) | varje verb som koden skriver har en post i `VERB`; provet läser verben ur en sluten lista filer och skrivsätt; `verbText()` slår upp med `Object.hasOwn()`, och reservvägen står kvar | `src/http/vy/mall.ts` (`VERB`, `verbText`) | `test/svenska-yta.test.ts` (AK 5, AK 6) |

### FR-37 — inga utåtlänkar till Linear (Story 2.3)

Linear är avvecklat, och ytan länkar aldrig dit (FR-37, B-14). En adress vars värd är `linear.app` eller en underdomän blir aldrig ett `href` i vyn. Klassningen är en enda funktion, `linearAdress()` i `src/http/vy/markdown.ts`. Den tolkar adressen med URL-tolken och läser värden ur `hostname`, så att versaler, användarnamn, port och en avslutande punkt aldrig avgör. Ärendenumret räknas bara som ett helt segment i sökvägen, `LOC-` följt av siffror. Vylagret bygger ett `href` ur en adress i data på två ställen, och båda frågar klassningen först. En bilaga med ett nummer blir en intern länk till ärendet med metan «tidigare Linear-länk», och titeln står kvar som text under den (`bilageRad()` i `src/http/routes/vy.ts`). En bilaga utan nummer blir titeln som ren text med metan «Linear-länk — Linear är avvecklat». En markdownlänk på dokumentsidan blir länktexten följd av den interna länken och metan inom parentes, eller länktexten och metan som ren text. Ärendetexten har inga markdownlänkar, och numret i en Linear-adress där blir en intern länk genom autolänkaren som förut. Andra adresser är oförändrade: bilagan går genom `sakerUrl()` och `esc()`, och markdownlänken escapas med hela texten. Omskrivningen sker bara vid visning, och `issue_attachments.url`, beskrivningarna, kommentarerna och valvets dokument rörs inte. Provet `test/linear-lankar.test.ts` prövar klassningen på sexton adresser och bilagorna och markdownlänkarna genom hela stacken. Det läser också elva sidor under `/vy`, där inget `href` får ha Linears värd.

Regeln står ordagrant som i regelkällan:

- Linear-adresser i vyn (FR-37, B-14, Story 2.3): en adress vars värd är `linear.app` eller en underdomän blir aldrig ett `href` i vylagret. `linearAdress()` i `src/http/vy/markdown.ts` är den enda klassningen: värden läses ur URL-tolkens `hostname` utan avslutande punkt, bara http och https räknas, och ärendenumret är det första hela segmentet i sökvägen som är `LOC-` följt av siffror. Varje ställe som bygger ett `href` ur en adress i data, i dag `bilageRad()` i `src/http/routes/vy.ts` och markdownlänkarna i `ersatt()` i `src/http/vy/markdown.ts`, frågar `linearAdress()` före sitt `href`, och ett nytt sådant ställe frågar den i samma diff. Med nummer blir adressen en intern länk till ärendet, skriven genom `esc()`, med metan «tidigare Linear-länk». Utan nummer blir den ren text med metan «Linear-länk — Linear är avvecklat». Omskrivningen sker bara vid visning, och data i databasen och valvet ändras aldrig för den. `test/linear-lankar.test.ts` läser varje sida i sin lista och fäller ett `href` med Linears värd.

| Krav | Mekanism | Kod | Test |
| --- | --- | --- | --- |
| FR-37 (Linears värdar) | en enda klassning, `linearAdress()`, med värden ur URL-tolken utan avslutande punkt och numret som ett helt segment i sökvägen; ingen del av adressens text söks igenom | `src/http/vy/markdown.ts` (`linearAdress`, `TIDIGARE_LINEAR_LANK`, `AVVECKLAD_LINEAR_LANK`) | `test/linear-lankar.test.ts` (AK 3) |
| FR-37 (bilagor och markdownlänkar) | `bilageRad()` och `ersatt()` frågar `linearAdress()` före sitt `href`; med nummer en intern länk genom `esc()` och metan «tidigare Linear-länk», utan nummer ren text med metan «Linear-länk — Linear är avvecklat» | `src/http/routes/vy.ts` (`bilageRad`), `src/http/vy/markdown.ts` (`ersatt`, `linearlank`) | `test/linear-lankar.test.ts` (AK 1, AK 2, AK 4) |
| FR-37 (ingen sida under `/vy`, datat orört) | vylagret bygger ett `href` ur en adress i data på två ställen, och båda frågar klassningen; omskrivningen sker vid visning i rena funktioner | `src/http/routes/vy.ts`, `src/http/vy/markdown.ts` | `test/linear-lankar.test.ts` (AK 4, AK 5) |

### FR-27 — samma stopp blir samma insats, också samtidigt (Story 6.2)

Insatslagret samlar de stopp som kräver en människa till en identitet (FR-27, B-09). `registreraInsats` i `src/services/insats.ts` skapar insatsen med `INSERT … ON CONFLICT (tenant_id, stopp_id) DO NOTHING RETURNING id`, och kommer ingen rad tillbaka läses den befintliga raden om med `FOR UPDATE`. Ingen SELECT före INSERT avgör om raden finns: en rad som en annan transaktion ännu inte har committat syns inte för en sådan SELECT, och då fick den andra registreringen unikhetsfelet och svaret 409. Nu ger samtidiga registreringar av samma stopp samma insats och svaret 200, den första med `registrerade_insats` och resten med `insatsen_fanns_redan`. Källorna kopplas med `ON CONFLICT … DO NOTHING` mot primärnyckeln `insats_kallor_unik`, och en källa som hör till en annan insats flyttas aldrig utan rapporteras som krock. Ett svar och en uppskjutning kräver en människonyckel (`kraver_manniska`), och CHECK-villkoret `insatser_svar_har_aktor` fäller ett svar utan aktör, också för ägarrollen. En registrering utan källor, med tom eller utelämnad lista, får `kalla_saknas` ur tjänstens enda grind. Provet `test/insats.test.ts` prövar allt genom hela stacken mot testdatabasen, med en konkurrent som ägarrollen håller okommitterad och med sex samtidiga anrop.

- Skapa-om-inte-finns (FR-27, B-09, Story 6.2): en rad med en unik nyckel skapas med `INSERT … ON CONFLICT (<nyckeln>) DO NOTHING RETURNING` och läses om när ingen rad kom tillbaka; ingen SELECT före INSERT avgör om raden finns. `registreraInsats` i `src/services/insats.ts` gör så för `(tenant_id, stopp_id)`, så att samtidiga registreringar av samma stopp ger samma insats och aldrig 409.

| Krav | Mekanism | Kod | Test |
| --- | --- | --- | --- |
| FR-27, ett stopp = en insats | `INSERT … ON CONFLICT (tenant_id, stopp_id) DO NOTHING RETURNING id` och återläsning med `FOR UPDATE`; ingen SELECT före INSERT | `src/services/insats.ts` (`registreraInsats`) | `test/insats.test.ts` (Story 6.2 AK 1, AK 2) |
| FR-27, ett källobjekt hör till en insats | primärnyckeln `insats_kallor_unik`; källornas `ON CONFLICT … DO NOTHING`, och en krock rapporteras i stället för att källan flyttas | `migrations/0015_insats.sql`, `src/services/insats.ts` (`registreraInsats`) | `test/insats.test.ts` (Story 6.2 AK 3) |
| FR-27, svaret kräver människa | `kraver_manniska` först i `besvaraInsats` och `skjutUppInsats`; CHECK `insatser_svar_har_aktor` | `src/services/insats.ts`, `migrations/0015_insats.sql` | `test/insats.test.ts` (Story 6.2 AK 4) |
| FR-27, tillhörighet och källa | `tillhor` bara `agare` eller `anvandare`; en tom eller utelämnad källista når tjänstens enda grind `kalla_saknas` | `src/actions/registry.ts` (`registrera_insats`), `src/services/insats.ts` | `test/insats.test.ts` (Story 6.2 AK 5) |

## Gränser för Etapp 2a

Ingen skrivfunktion från vyn (inga POST-rutter under `/vy`), ingen auth-UI, inga
notiser, ingen cutover. Ingen templatemotor och inga nya beroenden — express +
template literals. Ingen klient-JS. Ingen SQL i vylagret. Ingen exponering
utanför `127.0.0.1` (tailscale serve är dokumenterat men **inte kört**).

## Gränser för Etapp 1

Ingen vy/UI (den kom i Etapp 2a), inga notiser, ingen MCP-server, inga RLS-policyer (bara
`tenant_id`-kolumnen), inga cycles/estimates/roadmaps. Inga beroenden utanför
stacklistan i kravspecen.
