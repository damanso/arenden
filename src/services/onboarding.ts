/**
 * FR-25, FR-4, B-27, Story 9.4: operatörssteget efter Davids ja för kunden
 * (2026-10-16 13.21 och 11.00). Bara Locollabs systemaktör får ta emot.
 * Nya rader skrivs i den nya tenanten; anroparen får tillbaka sin tenant.
 * Människans namn prövas under mottagningslåset. Klartexten går bara till fil.
 * Allt hör till samma transaktion; filen städas om den inte blir committad.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import type { ClientBase, PoolClient } from 'pg';
import type { Aktor } from '../lib/aktor.js';
import { AppError, ForbiddenError } from '../lib/errors.js';
import { TENANT_ID } from '../lib/tenant.js';
import { hamtaEllerSkapaTeam } from './team.js';
import { skapaNyckel } from './nycklar.js';

let nyckelkatalog = path.join(homedir(), '.arenden', 'nycklar');

export function sattNyckelfilernasKatalog(katalog: string): string {
  const tidigare = nyckelkatalog;
  nyckelkatalog = katalog;
  return tidigare;
}

/** B-27: inställningen är lokal för den redan öppna transaktionen. */
export async function vaxlaTenant(client: ClientBase, tenantId: string): Promise<void> {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

interface Mottagningsindata {
  namn: string;
  team_key: string;
  team_namn: string;
  forsta_manniska: string;
}

export async function taEmotTenant(
  client: PoolClient,
  tenantId: string,
  aktor: Aktor,
  indata: Mottagningsindata,
): Promise<{
  tenant_id: string;
  tenant_namn: string;
  team_key: string;
  team_namn: string;
  nyckel_id: string;
  manniska: string;
  nyckel: string;
}> {
  if (aktor.typ !== 'system' || tenantId !== TENANT_ID) {
    throw new ForbiddenError('kraver_system', 'Bara en systemnyckel i Locollabs får ta emot en tenant.');
  }
  // Låset tas före uppslaget: två mottagningar får inte skapa samma människa.
  await client.query('SELECT tenantmottagningens_las()');
  const { rows } = await client.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM aktorens_tenanter('manniska', $1)", [indata.forsta_manniska],
  );
  if (rows.length > 0) {
    throw new AppError(409, 'aktorsnamnet_finns', undefined, {
      orsak: 'Människans namn används redan av en nyckel i en tenant, och ingenting skapades.',
    });
  }
  const ny = randomUUID();
  try {
    await vaxlaTenant(client, ny);
    await client.query('INSERT INTO tenants (id, namn) VALUES ($1, $2)', [ny, indata.namn]);
    const team = await hamtaEllerSkapaTeam(client, ny, indata.team_key, indata.team_namn);
    const utfardad = await skapaNyckel(client, ny, { typ: 'manniska', namn: indata.forsta_manniska });
    // Bara på den lyckade vägen: en aborterad transaktion tål ingen ny sats.
    await vaxlaTenant(client, tenantId);
    return {
      tenant_id: ny, tenant_namn: indata.namn, team_key: team.key, team_namn: team.namn,
      nyckel_id: utfardad.id, manniska: indata.forsta_manniska, nyckel: utfardad.nyckel,
    };
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    if (err !== null && typeof err === 'object' && 'code' in err && err.code === '23505'
      && 'constraint' in err) {
      if (err.constraint === 'tenants_namn_unik') {
        throw new AppError(409, 'tenantnamnet_finns', undefined, {
          orsak: 'En tenant med det namnet finns redan, och ingenting skapades.',
        });
      }
      if (err.constraint === 'teams_key_unik') {
        throw new AppError(409, 'teamnyckeln_finns', undefined, {
          orsak: 'Teamnyckeln används redan av en annan tenant, och ingenting skapades.',
        });
      }
    }
    throw new AppError(500, 'mottagningen_avbrots', undefined, {
      orsak: 'Mottagningen avbröts innan den var klar, och ingenting skapades.',
    });
  }
}

export async function skrivNyckelfil(tenantId: string, nyckel: string): Promise<string> {
  const fil = path.join(nyckelkatalog, `tenant-${tenantId}-manniska.txt`);
  let skapad = false;
  try {
    await mkdir(nyckelkatalog, { recursive: true, mode: 0o700 });
    // Eget handtag skiljer en halvskriven fil från en befintlig fil vid EEXIST.
    const handtag = await open(fil, 'wx', 0o600);
    skapad = true;
    try {
      await handtag.writeFile(`${nyckel}\n`, 'utf8');
    } finally {
      await handtag.close();
    }
    return fil;
  } catch {
    if (skapad) await taBortNyckelfil(fil).catch(() => undefined);
    throw new AppError(500, 'nyckelfilen_kunde_inte_skrivas', undefined, {
      orsak: 'Nyckelfilen kunde inte skrivas, och ingenting skapades.',
    });
  }
}

export async function taBortNyckelfil(fil: string): Promise<void> {
  await rm(fil, { force: true });
}
