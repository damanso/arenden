# Kravspec — Dokumentlänkar i läsvyn

```
MAL | DOKUMENTLANKAR i lasvyn: referenser till vaultdokument i arendebeskrivningar och kommentarer blir klickbara lankar till en ny dokumentsida GET /vy/dok/<sokvag>, som renderar dokumentet ur vaulten /home/hermes/brain — sa att David fran ett arende nar dokumentationen som skickats till personen med ett klick.
KALLA | Davids fraga 19/8 2026: "var ar lankarna till de skapade dokumenten sa jag snabbt kommer at dokumentationen som ar skickad till personen?" + granskningsfynd R5 (vitlista — inget lackage av privat vaultinnehall) + inventerade referensmonster i arendetexterna (verifierat via grep): (a) wikilankar [[sokvag/fil|alias]] och [[fil]], (b) rena filnamn utan sokvag t.ex. motesanalys-zeynep-2026-08-12.md och jakob-skogholm.md, (c) fulla sokvagar t.ex. 05-Dagligt/2026-08-07-morgonbrief.md + docs/KRAVSPEC-ETAPP-2A.md.
ARKITEKTUR | Allt bor i vylagret: ny GET-rutt under /vy i src/http/routes/vy.ts (eller egen routerfil monterad dar), markdown- och autolankningshjalpare bredvid src/http/vy/mall.ts — template literals, SAMMA esc() och sida()-ram som ovriga vyn (etapp 2a KRAV-5/6, proveniens orord), inga nya beroenden. Vaulten /home/hermes/brain lases ENDAST (lasbar for processen); autolankningen sker i RENDERINGSSTEGET i vyn — beskrivningar, kommentarer och databasen rors inte.
ARKITEKTUR | Filnamnsindex: vid serverstart byggs ASYNKRONT (utan att blockera starten) ett index filnamn → vaultrelativ sokvag over ENBART de vitlistade katalogerna (KRAV-2); cachas med enkel TTL ~10 min och byggs om forst nar TTL:n gatt ut. Ingen SQL-andring, ren lasyta — bara GET, precis som ovriga /vy.
KRAV-1 | GET /vy/dok/<vaultrelativ sokvag>: laser filen ur /home/hermes/brain och renderar markdown ENKELT — rubriker, listor, fetstil, lankar; kodblock som <pre> — med template literals genom samma mall/escape som ovriga vyn (ingen ny dependency, ingen markdownmotor), plus lanken "oppna i Obsidian": obsidian://open?vault=brain&file=<URL-enkodad sokvag utan .md>.
KRAV-2 | R5-SAKERHET MED VITLISTA (viktigast): ENDAST dokument under 01-Projekt/, 02-Områden/ledningsgrupp/, 02-Områden/hermes/, 02-Områden/linear-arkiv/ och 03-Resurser/ serveras. ALLT annat — inkl jag.md, journal/, 02-Områden/hälsa/, 05-Dagligt/, .git, .obsidian — ger 404 med texten "utanfor vyns dokumentomrade": ALDRIG filinnehall, ALDRIG katalognamnslackage i svaret. Path traversal blockeras hart: .., //, och symlink som pekar ut ur brain (realpath-kontroll pa upplost sokvag). Tester pa exakt detta.
KRAV-3 | AUTOLANKNING i arendebeskrivningar och kommentarer, i renderingssteget i vyn (INTE i datat): (a) [[sokvag|alias]] → lank till /vy/dok/sokvag.md med aliastexten; (b) [[fil]] → lank; (c) fulla sokvagar som slutar pa .md → lank; (d) rena filnamn *.md UTAN sokvag slas upp i filnamnsindexet — traff pa EXAKT ett stalle → lank, annars lamnas texten olankad. Referens till EJ vitlistat dokument lamnas som ren text utan lank och utan markering som avslojar att dokumentet finns.
KRAV-4 | LOC-N-referenser i samma texter blir interna lankar till /vy/arende/LOC-N (samma renderingssteg).
KRAV-5 | Prestanda: indexet byggs asynkront och cachas (TTL ~10 min); renderingen gor INGA filsystemssokningar per request utover cacheindexet; dokumentsidan laser EN fil per request.
KRAV-6 | Tester (vitest + supertest genom stacken): (a) vitlista-404 for jag.md, journal/x.md, ../etc/passwd och symlink ut ur vaulten — svaret innehaller "utanfor vyns dokumentomrade" och varken filinnehall eller katalognamn; (b) autolankning av ALLA fyra monstren a–d (inkl. att tvetydig filnamnstraff och ej vitlistad referens forblir ren text); (c) LOC-N-referens blir lank till /vy/arende/LOC-N; (d) obsidian-lanken ar korrekt URL-enkodad; (e) vitlistat dokument renderas med escapat innehall (KRAV-6, etapp 2a, galler aven har).
ACCEPTANS | npm run check gront — ALLA gamla tester (etapp 1 + 2a) plus de nya, inklistrad utdata. curl pa /vy/dok/02-Områden/ledningsgrupp/beslutsflode.md ger HTML med dokumentets innehall; curl pa /vy/dok/jag.md ger 404 utan innehallslackage; en arendesida med kand referens visar en klickbar dokumentlank. Prod oberord: inga nya beroenden i package.json, /api och ovriga /vy oforandrade.
AVGRANSNING | Ingen skrivning i vaulten, ingen sokning i dokumenten (vyns sok ar arenden), ingen rendering av bilder/bilagor, inga nya beroenden.
```

## Två beslut som togs där underlaget lämnade utrymme

1. **Vaultens sökväg är konfiguration, inte konstant** — `VAULT_PATH` i
   `src/config.ts` (default `/home/hermes/brain`). Annars hade testerna
   antingen läst den riktiga vaulten eller inte kunnat pröva vitlistan alls;
   nu pekar `test/env.ts` på en egen testvault, med `=` precis som etapp 1:s
   KRAV-19 kräver.
2. **404-svaret är ETT svar för allt** — utanför vitlistan, path traversal,
   symlink ut ur vaulten och "filen finns inte" ger identisk sida utan den
   begärda sökvägen. Ett särskilt "finns inte"-svar hade annars bekräftat
   existensen av dokument utanför området, vilket är precis vad R5 förbjuder.

Var varje krav är uppfyllt i kod och test: se tabellen "Dokumentlänkar — krav →
kod och test" i [`../README.md`](../README.md).
