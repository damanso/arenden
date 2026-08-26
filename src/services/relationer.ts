// K-3: relationer mellan ärenden och bilagor på ärenden.
//
// Båda är rena tjänstelagerfunktioner: actions-registret och vylagret innehåller
// ingen SQL (Etapp 1 ARKITEKTUR, Etapp 2a ARKITEKTUR).
import type { PoolClient } from 'pg';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import type { RelationTyp } from '../lib/validation.js';

// ---- Relationer ------------------------------------------------------------

export interface Relation {
  id: string;
  typ: RelationTyp;
  /**
   * Riktningen sedd FRÅN det ärende man frågade om. 'fran' = raden pekar bort
   * härifrån (vi blockerar), 'till' = raden pekar hit (vi blockeras).
   * Meningslös för 'related', som är symmetrisk.
   */
  riktning: 'fran' | 'till';
  motpart_id: string;
  motpart_identifier: string;
  motpart_titel: string;
  skapad: Date;
}

interface RelationRad extends Relation {
  motpart_nummer: number;
}

/**
 * Alla relationer ett ärende deltar i — BÅDA riktningarna, ur den ENA rad som
 * lagras per relation. Att också lagra motriktningen hade gjort de två raderna
 * fria att bli oense; här kan de inte bli det.
 */
export async function relationerFor(
  client: PoolClient,
  tenantId: string,
  issueId: string,
): Promise<Relation[]> {
  const { rows } = await client.query<RelationRad>(
    `SELECT * FROM (
       SELECT r.id, r.typ, 'fran' AS riktning,
              m.id AS motpart_id,
              mt.key || '-' || m.sequence_number AS motpart_identifier,
              m.title AS motpart_titel,
              m.sequence_number AS motpart_nummer,
              r.skapad
         FROM issue_relations r
         JOIN issues m ON m.id = r.till_issue_id
         JOIN teams mt ON mt.id = m.team_id
        WHERE r.tenant_id = $1 AND r.fran_issue_id = $2
       UNION ALL
       SELECT r.id, r.typ, 'till' AS riktning,
              m.id AS motpart_id,
              mt.key || '-' || m.sequence_number AS motpart_identifier,
              m.title AS motpart_titel,
              m.sequence_number AS motpart_nummer,
              r.skapad
         FROM issue_relations r
         JOIN issues m ON m.id = r.fran_issue_id
         JOIN teams mt ON mt.id = m.team_id
        WHERE r.tenant_id = $1 AND r.till_issue_id = $2
     ) rel
     ORDER BY rel.typ, rel.riktning, rel.motpart_nummer`,
    [tenantId, issueId],
  );
  // motpart_nummer är intern sorteringsnyckel och lämnar aldrig tjänstelagret.
  return rows.map(({ motpart_nummer: _, ...relation }) => relation);
}

/**
 * Alla source_ref som redan bär en relation. Återläsningen använder mängden för
 * att INTE anropa link_issues på något som redan finns: en write-action måste
 * skriva en händelserad (KRAV-8), så ett no-op-anrop hade lämnat en rad i
 * loggen vid varje omkörning. Idempotensen ska vara tyst.
 */
export async function befintligaRelationsRefs(
  client: PoolClient,
  tenantId: string,
): Promise<Set<string>> {
  const { rows } = await client.query<{ source_ref: string }>(
    'SELECT source_ref FROM issue_relations WHERE tenant_id = $1 AND source_ref IS NOT NULL',
    [tenantId],
  );
  return new Set(rows.map((r) => r.source_ref));
}

export interface LaggTillRelationInput {
  fran_issue_id: string;
  till_issue_id: string;
  typ: RelationTyp;
  source_ref?: string;
}

/**
 * Idempotent på samma sätt som importen (KRAV-16): ON CONFLICT DO NOTHING UTAN
 * konfliktmål, så att den fångar ALLA tre unika villkoren — det riktade
 * (fran, till, typ), det symmetriska normaliserade paret för 'related', och
 * source_ref. Ett konfliktmål hade bara fångat ett av dem, och en omkörning
 * med spegelvänt par hade kraschat i stället för att bli en no-op.
 */
export async function laggTillRelation(
  client: PoolClient,
  tenantId: string,
  input: LaggTillRelationInput,
): Promise<{ relation: Relation; nyskapad: boolean }> {
  // CHECK-villkoret i databasen fångar det också, men som 400 invalid_input
  // utan att säga vad som var fel. Här blir felet läsbart.
  if (input.fran_issue_id === input.till_issue_id) {
    throw new BadRequestError('relation_till_sig_sjalv', 'ett ärende kan inte relatera till sig självt');
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO issue_relations (tenant_id, fran_issue_id, till_issue_id, typ, source_ref)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [tenantId, input.fran_issue_id, input.till_issue_id, input.typ, input.source_ref ?? null],
  );
  const nyskapad = rows.length > 0;

  const alla = await relationerFor(client, tenantId, input.fran_issue_id);
  const traff = alla.find((r) => r.typ === input.typ && r.motpart_id === input.till_issue_id);
  // Kan bara inträffa om raden hann försvinna mellan INSERT och läsning i samma
  // transaktion — omöjligt i praktiken, men vi gissar inte fram ett svar.
  if (!traff) throw new NotFoundError('relation');
  return { relation: traff, nyskapad };
}

// ---- Bilagor ---------------------------------------------------------------

export interface Bilaga {
  id: string;
  titel: string;
  url: string;
  undertitel: string | null;
  source_ref: string | null;
  skapad: Date;
}

export async function bilagorFor(
  client: PoolClient,
  tenantId: string,
  issueId: string,
): Promise<Bilaga[]> {
  const { rows } = await client.query<Bilaga>(
    `SELECT id, titel, url, undertitel, source_ref, skapad
       FROM issue_attachments
      WHERE tenant_id = $1 AND issue_id = $2
      ORDER BY skapad, id`,
    [tenantId, issueId],
  );
  return rows;
}

/** Samma tysta idempotens som befintligaRelationsRefs, för bilagorna. */
export async function befintligaBilageRefs(
  client: PoolClient,
  tenantId: string,
): Promise<Set<string>> {
  const { rows } = await client.query<{ source_ref: string }>(
    'SELECT source_ref FROM issue_attachments WHERE tenant_id = $1 AND source_ref IS NOT NULL',
    [tenantId],
  );
  return new Set(rows.map((r) => r.source_ref));
}

export interface LaggTillBilagaInput {
  issue_id: string;
  titel: string;
  url: string;
  undertitel?: string | null;
  source_ref?: string;
  skapad?: string;
}

/** Idempotent på (issue_id, url) OCH på source_ref — samma mönster som ovan. */
export async function laggTillBilaga(
  client: PoolClient,
  tenantId: string,
  input: LaggTillBilagaInput,
): Promise<{ bilaga: Bilaga; nyskapad: boolean }> {
  const { rows } = await client.query<Bilaga>(
    `INSERT INTO issue_attachments (tenant_id, issue_id, titel, url, undertitel, source_ref, skapad)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT DO NOTHING
     RETURNING id, titel, url, undertitel, source_ref, skapad`,
    [
      tenantId,
      input.issue_id,
      input.titel,
      input.url,
      input.undertitel ?? null,
      input.source_ref ?? null,
      input.skapad ?? null,
    ],
  );
  const ny = rows[0];
  if (ny) return { bilaga: ny, nyskapad: true };

  const befintlig = await client.query<Bilaga>(
    `SELECT id, titel, url, undertitel, source_ref, skapad
       FROM issue_attachments
      WHERE tenant_id = $1 AND issue_id = $2 AND url = $3`,
    [tenantId, input.issue_id, input.url],
  );
  const rad = befintlig.rows[0];
  if (!rad) throw new NotFoundError('bilaga');
  return { bilaga: rad, nyskapad: false };
}
