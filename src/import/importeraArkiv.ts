// Importerar linear-arkivet (KRAV-14 till KRAV-16).
//
//   npm run import [katalog]     (default: /home/hermes/brain/02-Områden/linear-arkiv)
//
// Egenskaper:
//  - LOC-numreringen BEHÅLLS (sequence_number ur filnamnet) och teamets sekvens
//    sätts efteråt över högsta importerade numret (KRAV-15).
//  - Idempotent via source_ref + INSERT ... ON CONFLICT: en omkörning skapar noll
//    dubbletter och rapporterar 0 nya (KRAV-16).
//  - Allt sker i EN transaktion — en halv import finns inte.
//  - Importens events stämplas aktor_typ 'system', aktor_namn 'linear-import'.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closePool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import type { Aktor } from '../lib/aktor.js';
import { TENANT_ID } from '../lib/tenant.js';
import {
  hamtaEllerSkapaProjekt,
  importeraArende,
  sattSekvens,
} from '../services/arenden.js';
import { skrivHandelse } from '../services/handelser.js';
import { laggTillKommentar } from '../services/kommentarer.js';
import { hamtaEllerSkapaTeam, stateAvTyp, stateMedNamn } from '../services/team.js';
import { arArendefil, parsaArkivfil, type ArkivArende } from './parsaArkiv.js';

export const DEFAULT_ARKIV = '/home/hermes/brain/02-Områden/linear-arkiv';

const IMPORTAKTOR: Aktor = { typ: 'system', namn: 'linear-import' };

export interface ImportResultat {
  filer: number;
  nya_arenden: number;
  oforandrade_arenden: number;
  nya_kommentarer: number;
  oforandrade_kommentarer: number;
  hogsta_nummer: number;
}

export async function importeraArkiv(
  katalog: string,
  log: (msg: string) => void = () => {},
): Promise<ImportResultat> {
  const filer = (await readdir(katalog)).filter(arArendefil).sort();
  const arenden: ArkivArende[] = [];
  for (const fil of filer) {
    arenden.push(parsaArkivfil(fil, await readFile(path.join(katalog, fil), 'utf8')));
  }
  arenden.sort((a, b) => a.nummer - b.nummer);

  const resultat: ImportResultat = {
    filer: filer.length,
    nya_arenden: 0,
    oforandrade_arenden: 0,
    nya_kommentarer: 0,
    oforandrade_kommentarer: 0,
    hogsta_nummer: 0,
  };

  await withTransaction(async (client) => {
    const team = await hamtaEllerSkapaTeam(client, TENANT_ID, 'LOC', 'Locollabs');
    const backlog = await stateAvTyp(client, team.id, 'backlog');
    const projektCache = new Map<string, string>();

    for (const a of arenden) {
      resultat.hogsta_nummer = Math.max(resultat.hogsta_nummer, a.nummer);

      let projectId: string | null = null;
      if (a.projekt) {
        const cachat = projektCache.get(a.projekt);
        projectId = cachat ?? (await hamtaEllerSkapaProjekt(client, TENANT_ID, a.projekt));
        projektCache.set(a.projekt, projectId);
      }

      // Arkivets statusnamn är Linears och matchar standarduppsättningen
      // (Backlog/Todo/In Progress/Done/Canceled). Okänt värde landar i Backlog.
      const state = (await stateMedNamn(client, team.id, a.status)) ?? backlog;

      const { id, identifier, nyskapad } = await importeraArende(client, TENANT_ID, {
        team_id: team.id,
        team_key: team.key,
        sequence_number: a.nummer,
        source_ref: a.source_ref,
        state_id: state.id,
        project_id: projectId,
        title: a.titel,
        description: a.beskrivning,
        labels: a.labels,
        skapad: a.skapad || null,
        uppdaterad: a.uppdaterad || null,
      });

      if (nyskapad) {
        resultat.nya_arenden += 1;
        await skrivHandelse(client, TENANT_ID, IMPORTAKTOR, {
          issueId: id,
          verb: 'importerade_arende',
          payload: { identifier, source_ref: a.source_ref, status: a.status },
        });
      } else {
        resultat.oforandrade_arenden += 1;
      }

      for (const k of a.kommentarer) {
        // Kommentarernas författare kommer ur arkivet (Linears namn) — vi
        // hittar inte på en aktör, vi bevarar den som fanns.
        const fore = await client.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM comments WHERE source_ref = $1',
          [k.source_ref],
        );
        await laggTillKommentar(
          client,
          TENANT_ID,
          id,
          k.body,
          { typ: 'manniska', namn: k.forfattare },
          { source_ref: k.source_ref, ...(k.tidpunkt ? { skapad: k.tidpunkt } : {}) },
        );
        if (fore.rows[0]!.n === '0') resultat.nya_kommentarer += 1;
        else resultat.oforandrade_kommentarer += 1;
      }
    }

    if (resultat.hogsta_nummer > 0) {
      await sattSekvens(client, team.sekvensnamn, resultat.hogsta_nummer);
    }
  });

  log(
    `OK: ${resultat.filer} arkivfiler — ${resultat.nya_arenden} nya ärenden, ` +
      `${resultat.oforandrade_arenden} oförändrade, ${resultat.nya_kommentarer} nya kommentarer, ` +
      `${resultat.oforandrade_kommentarer} oförändrade kommentarer. ` +
      `Högsta nummer: LOC-${resultat.hogsta_nummer} (sekvensen fortsätter därefter).`,
  );
  return resultat;
}

// ---- CLI ----
const isCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const katalog = process.argv[2] ?? DEFAULT_ARKIV;
  try {
    await importeraArkiv(katalog, (msg) => console.log(msg));
  } catch (err) {
    console.error(`FATAL: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
