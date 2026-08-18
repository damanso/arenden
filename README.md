# Ärendeplattformen — Etapp 1 (skuggdrift)

Egen ärendeplattform som ersätter Linears API-yta för agenterna: datamodell,
actions-API med proveniens, import av linear-arkivet och adapter. **Ingen
cutover** — Linear är fortfarande skarp källa, och varken `~/.hermes/skills`
eller `/opt/redovisning` rörs. Omkopplingen av de 15 skripten är Etapp 2.

Kravspecen som bygget svarar mot: [`docs/KRAVSPEC-ETAPP-1.md`](docs/KRAVSPEC-ETAPP-1.md).

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
npm run build      # tsc, ska ge noll fel
npm test           # vitest + supertest mot RIKTIG Postgres på 5436
```

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
| 13 express/helmet/rate-limit, 127.0.0.1:3002 | `src/http/app.ts`, `src/server.ts` | `test/actions.test.ts` |
| 14 import av arkivet | `src/import/parsaArkiv.ts`, `src/import/importeraArkiv.ts` | `test/import.test.ts` |
| 15 LOC-numrering bevarad + setval | `importeraArende`, `sattSekvens` | `test/import.test.ts` |
| 16 idempotent via source_ref | `ON CONFLICT` i `importeraArende`/`laggTillKommentar` | `test/import.test.ts` |
| 17 TS-adapter | `src/adapter/index.ts` | — (bibliotek, kopplas in i Etapp 2) |
| 18 Python-klient | `adapter/arenden_klient.py` | — (bibliotek, kopplas in i Etapp 2) |
| 19 testrigg | `vitest.config.ts`, `test/env.ts` (`=`, aldrig `??=`), `test/globalSetup.ts`, `test/setup.ts` | hela sviten |
| 20 obligatoriska testfall a–e | — | `sekvens-race` · `claim-race` · `proveniens` · `sok` · `import` |

## Gränser för Etapp 1

Ingen vy/UI, inga notiser, ingen MCP-server, inga RLS-policyer (bara
`tenant_id`-kolumnen), inga cycles/estimates/roadmaps. Inga beroenden utanför
stacklistan i kravspecen.
