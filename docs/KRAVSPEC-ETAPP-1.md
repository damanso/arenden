# Kravspec — Etapp 1, ärendeplattformen

Fastställd 2026-08-18 (Davids beslut #21, överlämning #7). Granskaren ska kunna
bocka av varje KRAV mot kod och test utan egen letning (BMAD).

```
MAL | Etapp 1 av egen arendeplattform (skuggdrift): nytt Node/TS+Postgres-system i /opt/arenden som ersatter Linears API-yta for agenterna — datamodell, actions-API med proveniens, import av linear-arkivet samt adapter — utan cutover; Linear forblir skarp kalla tills Etapp 2.
KALLA | Davids beslut #21 + overlamning #7 + /home/hermes/brain/02-Områden/hermes/arendeplattform-research-2026-08-18.md (kravkarta) + .../arendeplattform-extern-research-2026-08-18.md (Postgres-monster, AI Act art 50) + monsterkallan /opt/redovisning/docs/ARKITEKTUR.md + kontraktsreferens ~/.hermes/skills/linear_vakt.py rad 85–130, overlamning.py rad 110–130, handelse_router.py rad 111–158.
ARKITEKTUR | Redovisningsmonstren ateranvands oforandrat: actions-registry med def({name, title, sensitivity, inputSchema, handler}) dar inputSchema alltid ar zod .strict(), allt muterande gar via executeAction → tjanstelager → Postgres (pg, ra SQL — ingen ORM); numrerad idempotent migrationskedja migrations/NNNN_snake_case.sql; src/config.ts ar ENDA stallet som laser process.env (undantag migrations-CLI) och servern vagrar starta med ofullstandig config; ingen SQL i registret, ingen affarslogik i http-lagret.
ARKITEKTUR | Sluten stacklista (redovisningens klass, inget annat): Node >= 22, ESM, TypeScript ^5.7 strict (bygg tsc, dev tsx), express ^5, helmet, express-rate-limit, zod ^3.25, pg ^8.16, dotenv, vitest ^3.2 + supertest mot riktig Postgres (aldrig mockad databas). Inga ORM:er, ingen Redis, inga ytterligare beroenden.
KRAV-1 | Projektskelett i /opt/arenden (git-repot finns, main): package.json (enkelt serverprojekt, inga workspaces) med scripts dev/build/migrate/test/import, strikt tsconfig; `npm ci` och `npm run build` gar gront pa ren klon.
KRAV-2 | docker-compose.yml med toppniva `name: arenden` (eget COMPOSE-projektnamn i filen — ALDRIG delat med annat system; incidenten 17/8 ar lagen): Postgres 16-klass bunden till 127.0.0.1:5435 med egen namngiven volym. Separat testdatabas (egen composefil eller tjanst) med projektnamn `arenden-test`, 127.0.0.1:5436, egen volym.
KRAV-3 | Migrationer kors med `npm run migrate` som agarroll via DATABASE_ADMIN_URL, idempotent (aterkorning = no-op); appen ansluter som icke-superuser `app`.
KRAV-4 | ALLA tabeller har tenant_id (NOT NULL, en fast tenant i Etapp 1) + index — RLS-berett fran dag 1; sjalva RLS-policyerna ar Etapp 3 och byggs inte nu.
KRAV-5 | teams(id, key UNIK t.ex. 'LOC', namn): vid teamskapande skapas en dedikerad `CREATE SEQUENCE` for teamets arendenummer; issues.sequence_number satts med nextval i create-transaktionen — ALDRIG MAX+1. identifier = `<key>-<nummer>` (t.ex. LOC-330).
KRAV-6 | workflow_states(id, team_id, namn, typ CHECK i backlog|unstarted|started|completed|canceled, position); standarduppsattning seedas per team.
KRAV-7 | projects, labels + issue_labels (m2m), issues(team_id, project_id nullbar, state-referens, priority int CHECK 1–4 nullbar, due_date nullbar, title, description, claimad_av nullbar, source_ref UNIK nullbar, skapad/uppdaterad), comments(issue_id, body, aktor_typ, aktor_namn, source_ref UNIK nullbar, skapad).
KRAV-8 | events ar append-only audit: (id, tenant_id, issue_id nullbar, aktor_typ CHECK manniska|agent|system NOT NULL, aktor_namn NOT NULL, verb, payload jsonb, tidpunkt); UPDATE/DELETE blockeras med trigger + REVOKE. VARJE mutation via actions skriver sin event-rad i SAMMA transaktion — proveniens ar forstaklasskrav (AI Act art 50; "agentkommentarer stamplas David"-smartan far inte aterskapas).
KRAV-9 | Sok: GENERATED tsvector-kolumner (regconfig 'simple' — blandad sv/en-text) + GIN-index pa issues(title+description) och comments(body).
KRAV-10 | api_keys(id, nyckelhash, aktor_typ manniska|agent|system, aktor_namn, aktiv): alla /api-anrop kraver `Authorization: Bearer`; skrivning utan giltig nyckel avvisas med 401 och ingen rad skrivs — anonym skrivning ar omojlig. Aktorn i events tas ALLTID ur nyckeln, aldrig ur request-body.
KRAV-11 | Actions (samtliga via executeAction, zod-strict indata): list_issues (cursor-paginerad, filter pa state-typ[], team_key, label, project), get_issue (identifier 'LOC-N', inkl kommentarer + events), create_issue (title, description, team_key, labels[], priority, due), update_issue_state (identifier + state-typ eller state-id), add_comment (identifier, body), list_states (team_key → id/namn/typ), search_issues (fritext → tsvector over arenden+kommentarer, rankad), claim_next_issue.
KRAV-12 | claim_next_issue (agentkon): `SELECT ... FOR UPDATE SKIP LOCKED` pa aldsta oclaimade arendet i backlog/unstarted (ordnat prio, skapad), satter started-state + claimad_av=aktorn i samma transaktion och returnerar arendet; tva samtidiga anrop far OLIKA arenden; tom ko returnerar null, inte fel.
KRAV-13 | HTTP-server enligt redovisningsmonstret: express + helmet + express-rate-limit, bind 127.0.0.1, port 3002 (ur config), GET /health utan nyckel, POST /api/actions/:name → executeAction; transportlagret ar bara transport.
KRAV-14 | Importskript (`npm run import`) laser /home/hermes/brain/02-Områden/linear-arkiv/ (312 st LOC-N.md; _las-mig.md hoppas over): parsar frontmatter (arende, status, skapad, uppdaterad), H1-titeln efter 'LOC-N — ', raden `**Status:** ... **Projekt:** ... **Labels:** ...`, `## Beskrivning` samt kommentarssektioner; skapar team LOC, states, projekt och labels vid behov.
KRAV-15 | Importen BEHALLER LOC-numreringen (sequence_number ur filnamnet) och satter efterat teamets sekvens med setval over hogsta importerade nummer (329) sa nya arenden fortsatter darover.
KRAV-16 | Importen ar idempotent via source_ref-monstret fran CRM-kontraktet ('linear-arkiv:LOC-N' for arenden, deterministisk kommentarsnyckel for kommentarer) + INSERT ... ON CONFLICT: aterkorning skapar noll dubbletter och rapporterar antal nya/oforandrade; importens events stamplas aktor_typ system, aktor_namn 'linear-import'.
KRAV-17 | Adapter (src/adapter/, exporteras som bibliotek — skripten kopplas om forst i Etapp 2) med funktioner som speglar dagens GraphQL-kontrakt exakt: listIssues({stateTyper, teamKey, label, projekt, cursor, limit}) paginerad; getWorkflowStates(teamKey) → [{id, namn, typ}]; createIssue({titel, beskrivning, teamKey, labels, priority, due}) → {id, identifier}; updateIssueState(identifier, stateTypEllerId); addComment(identifier, body); sokLabel(namn) → id|null. Adaptern anropar actions-API:t via HTTP + bearer (bas-URL och nyckel ur config) — aldrig databasen direkt.
KRAV-18 | Python-klient adapter/arenden_klient.py med samma sex funktioner, ENDAST stdlib (urllib.request, json — samma monster som skillsens gql-hjalpare), nyckel ur fil/miljovariabel; importbar av Etapp 2:s skript. Inga befintliga skript rors nu.
KRAV-19 | Testrigg: vitest mot riktig Postgres pa 5436 (testcompose enligt KRAV-2); test/env.ts satter env med `=` (aldrig `??=`); mall-databas migreras EN gang i globalSetup och aterskapas farsk fore varje testfil; HTTP testas med supertest genom hela stacken.
KRAV-20 | Obligatoriska testfall: (a) sekvensrace — tva samtidiga create_issue ger tva olika nummer; (b) tva samtidiga claim_next_issue ger olika arenden (SKIP LOCKED); (c) proveniens-tvang — skrivning utan/med ogiltig nyckel ger 401 och ingen rad, varje lyckad mutation har event-rad med ratt aktor, UPDATE/DELETE pa events avvisas av databasen; (d) search_issues traffar ord i titel OCH ord som bara finns i en kommentar; (e) import kord tva ganger mot fixturfiler ger identiska radantal andra gangen.
ACCEPTANS | Granskaren far endast denna spec + de pekade dokumenten och ska kunna bocka av varje KRAV mot kod och test utan egen letning (BMAD).
ACCEPTANS | Pa ren klon, med inklistrad utdata (inga pastaenden utan korning): `docker compose up -d` for bada databaserna → `npm ci` → `npm run migrate` → `npm run build` (tsc noll fel) → `npm test` — allt gront.
ACCEPTANS | `docker compose ls` visar projekten `arenden` och `arenden-test` som EGNA projekt, verifierat skilda fran alla befintliga (sarskilt redovisningens) i namn, portar (5435/5436, 3002) och volymer.
ACCEPTANS | `npm run import` mot riktiga arkivet: 312 arenden med kommentarer inlasta, LOC-numrering bevarad (stickprov: get_issue 'LOC-316' matchar arkivfilen), omedelbar andra korning rapporterar 0 nya rader.
ACCEPTANS | Prod-redovisningen OBERORD: /opt/redovisning och ~/.hermes/skills utan diff efter bygget; redovisningens containrar och portar (bl.a. 5433) opaverkade fore/efter, verifierat med docker ps.
AVGRANSNING | Ingen cutover och inga andringar i ~/.hermes/skills eller /opt/redovisning — Linear fortsatter vara skarp kalla under skuggdriften; omkoppling av de 15 skripten ar Etapp 2.
AVGRANSNING | Ingen vy/UI, inga notiser, ingen multi-tenant-UI eller RLS-policyer (endast tenant_id-kolumnen), ingen MCP-server, inga cycles/estimates/roadmaps, inga beroenden utover den slutna stacklistan (inga ORM:er, ingen Redis).
```

## Beslut som togs där underlaget lämnade utrymme

- **tsvector-regconfig `'simple'`** — arkivet blandar svenska och engelska;
  `'swedish'`-stemming hade gett oförutsägbara träffar på engelska termer.
- **Port 3002** enligt förslaget (redovisningen äger 3000/3001-området).
- **Sex adapterfunktioner** ur skillsens faktiska GraphQL-anrop: paginerad
  listning med state-typ-filter, states per team, skapa med labels/prio/due,
  statusuppdatering via typ *eller* id (`done_state`-mönstret slår upp per typ),
  kommentar, samt label-sök. `get_issue` via identifier täcker
  `arende_uuid`-mönstret i `handelse_router.py`.
