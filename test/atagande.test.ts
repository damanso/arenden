import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { redovisaResultat } from '../src/services/atagande.js';
import { kor, nyNyckel, seedaTeam, TENANT_ID } from './helpers.js';

// Åtagandet (spec: Astra 2026-09-09). Ramen: ägaren ger riktning, användaren
// bär utgången till verkligheten, Hermes är bolaget och gör allt annat självt.
//
// Provet finns för att de fyra lögnerna i specen ska vara OMÖJLIGA, inte
// avrådda. Varje test nedan går rött om spärren tas bort — det är kravet på
// ett prov i det här huset.

const GRUND = [{ typ: 'beslut', id: '153', version: '1' }];
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND[0] };
const UTAT = { handling: 'Skicka svaret till Eva', slag: 'utathandling', grund: GRUND[0] };
const RIKTNING = { handling: 'Välj vilken leverans som går först', slag: 'riktning', grund: GRUND[0] };
const SEN = '2026-09-30T08:00:00Z';

async function nyttArende(app: Express, nyckel: string, titel: string): Promise<string> {
  const svar = await kor(app, nyckel, 'create_issue', { title: titel, team_key: 'LOC' });
  expect(svar.status).toBe(200);
  return svar.body.result.identifier as string;
}

describe('åtagandet: den beständiga länken', () => {
  let app: Express;
  let hermes: string;
  let david: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  // ---- 1. tillhör härleds, fylls aldrig i -------------------------------
  it('tillhor härleds ur nästa stegs slag — det finns inget fält att sätta', async () => {
    const fall: [Record<string, unknown>, string][] = [
      [INTERNT, 'hermes'],
      [RIKTNING, 'agare'],
      [UTAT, 'anvandare'],
    ];
    for (const [nasta, vantad] of fall) {
      const id = await nyttArende(app, hermes, `Härledning ${vantad}`);
      const svar = await kor(app, hermes, 'registrera_atagande', {
        identifier: id,
        grund: GRUND,
        nasta,
        foljs_upp: SEN,
      });
      expect(svar.status).toBe(200);
      expect(svar.body.result.atagande.tillhor).toBe(vantad);
    }

    // Motprovet: fältet går inte att skicka in. Strict-schemat avvisar det,
    // så "sätt tillhor=hermes" är ingen väg runt människospärren.
    const id = await nyttArende(app, hermes, 'Försök sätta tillhor');
    const nekad = await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: UTAT,
      foljs_upp: SEN,
      tillhor: 'hermes',
    });
    expect(nekad.status).toBe(400);
  });

  // ---- 2. övertaget kan inte påstås -------------------------------------
  it('utföraren tas ur nyckeln — en överlämning kan inte kvittera åt någon annan', async () => {
    const id = await nyttArende(app, hermes, 'Övertagande');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });

    // Försöket att ange en annan utförare avvisas av schemat.
    const pastatt = await kor(app, hermes, 'ta_over_atagande', {
      identifier: id,
      nasta: INTERNT,
      foljs_upp: SEN,
      utforare_namn: 'cto',
    });
    expect(pastatt.status).toBe(400);

    const svar = await kor(app, david, 'ta_over_atagande', {
      identifier: id,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    expect(svar.status).toBe(200);
    expect(svar.body.result.lage).toBe('overtaget');
    expect(svar.body.result.utforare_namn).toBe('david');
    expect(svar.body.result.utforare_typ).toBe('manniska');
    expect(svar.body.result.overtaget_nar).not.toBeNull();
  });

  // ---- 3. genomfört kräver ett resultat ---------------------------------
  it('genomfört utan belägg går inte att skriva', async () => {
    const id = await nyttArende(app, hermes, 'Resultat utan belägg');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    await kor(app, hermes, 'ta_over_atagande', { identifier: id, nasta: INTERNT, foljs_upp: SEN });

    const utan = await kor(app, hermes, 'redovisa_resultat', {
      identifier: id,
      sammanfattning: 'Det är gjort',
      belagg: [],
    });
    expect(utan.status).toBe(400);

    const med = await kor(app, hermes, 'redovisa_resultat', {
      identifier: id,
      sammanfattning: 'Det är gjort',
      belagg: [{ typ: 'prov', id: 'brieflankar', version: '2026-09-09' }],
    });
    expect(med.status).toBe(200);
    expect(med.body.result.lage).toBe('genomfort');
    expect(med.body.result.data.resultat.kontrollerat).toBeTruthy();
  });

  // ---- 4. ett hinder som blir gammalt är inget resultat ------------------
  it('hindrat kan inte bli genomfört — vägen tillbaka går via övertagande', async () => {
    const id = await nyttArende(app, hermes, 'Hinder');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    const hindrad = await kor(app, hermes, 'hindra_atagande', {
      identifier: id,
      orsak: 'DNS-ändringen är inte gjord',
      belagg: { typ: 'beslut', id: '145' },
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    expect(hindrad.status).toBe(200);
    expect(hindrad.body.result.lage).toBe('hindrat');

    const genvag = await kor(app, hermes, 'redovisa_resultat', {
      identifier: id,
      sammanfattning: 'Hindret är gammalt nu',
      belagg: [{ typ: 'prov', id: 'x' }],
    });
    expect(genvag.status).toBe(400);
    expect(genvag.body.error).toBe('otillaten_overgang');
  });

  // ---- 5. statusen kan inte sättas vid sidan av åtagandet ----------------
  it('update_issue_state kan inte stänga ett åtagande som inte är genomfört', async () => {
    const id = await nyttArende(app, hermes, 'Sidodörr till Done');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    const svar = await kor(app, hermes, 'update_issue_state', {
      identifier: id,
      state_typ: 'completed',
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('atagandet_styr_statusen');
  });

  // ---- 6. samma svar kan inte verkställas två gånger ---------------------
  it('en svarsversion kan bara behandlas en gång; ny text ger ny version', async () => {
    const forsta = await kor(app, hermes, 'registrera_svarsversion', {
      beslut_id: 153,
      svar_hash: 'a1b2c3d4e5f60718',
    });
    expect(forsta.body.result.nyskapad).toBe(true);

    const andra = await kor(app, hermes, 'registrera_svarsversion', {
      beslut_id: 153,
      svar_hash: 'a1b2c3d4e5f60718',
    });
    expect(andra.body.result.nyskapad).toBe(false);

    const komplettering = await kor(app, hermes, 'registrera_svarsversion', {
      beslut_id: 153,
      svar_hash: 'ffffffffffffffff',
    });
    expect(komplettering.body.result.nyskapad).toBe(true);
  });

  // ---- 7. ett beslut har ett huvudåtagande ------------------------------
  it('beslutskopplingen är unik — en omkörning hittar samma åtagande', async () => {
    const ett = await nyttArende(app, hermes, 'Första');
    const tva = await nyttArende(app, hermes, 'Andra');

    const a = await kor(app, hermes, 'koppla_beslut', { beslut_id: 99, identifier: ett });
    expect(a.body.result.nyskapad).toBe(true);

    const b = await kor(app, hermes, 'koppla_beslut', { beslut_id: 99, identifier: tva });
    expect(b.body.result.nyskapad).toBe(false);
    expect(b.body.result.identifier).toBe(ett);
  });

  // ---- 8. utåthandlingen kan inte döpas om till internt ------------------
  it('att göra en utåthandling intern kräver ny grund', async () => {
    const id = await nyttArende(app, hermes, 'Utåthandling');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: UTAT,
      foljs_upp: SEN,
    });

    const utan = await kor(app, hermes, 'andra_atagande', { identifier: id, nasta: INTERNT });
    expect(utan.status).toBe(400);
    expect(utan.body.error).toBe('utathandling_kringgas');

    const med = await kor(app, hermes, 'andra_atagande', {
      identifier: id,
      nasta: INTERNT,
      grund: { typ: 'beslut', id: '160', version: '1' },
    });
    expect(med.status).toBe(200);
    expect(med.body.result.tillhor).toBe('hermes');
  });

  // ---- 9. en gammal revision får inte utföra ----------------------------
  it('ett anrop som utgår från en gammal revision avvisas', async () => {
    const id = await nyttArende(app, hermes, 'Revision');
    const skapad = await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    const gammal = skapad.body.result.atagande.revision as number;

    await kor(app, hermes, 'andra_atagande', { identifier: id, foljs_upp: SEN });

    const svar = await kor(app, hermes, 'ta_over_atagande', {
      identifier: id,
      nasta: INTERNT,
      foljs_upp: SEN,
      forvantad_revision: gammal,
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('gammal_revision');
  });

  // ---- 10. villkoret överlever hela vägen -------------------------------
  it('ett villkor som inte är uppfyllt blockerar genomfört', async () => {
    const id = await nyttArende(app, hermes, 'Villkor');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
      villkor: [
        {
          text: 'Gör X endast om Y håller',
          kalla: { typ: 'beslut', id: '153' },
          galler: 'utfora',
          kontroll: 'kontrollera Y i redovisningen',
          utfall: 'okant',
        },
      ],
    });
    await kor(app, hermes, 'ta_over_atagande', { identifier: id, nasta: INTERNT, foljs_upp: SEN });

    const nekad = await kor(app, hermes, 'redovisa_resultat', {
      identifier: id,
      sammanfattning: 'Gjort',
      belagg: [{ typ: 'prov', id: 'y' }],
    });
    expect(nekad.status).toBe(400);
    expect(nekad.body.error).toBe('villkor_haller_inte');

    // Ett villkor som inte är okänt kräver belägg — även det är en spärr.
    const utanBelagg = await kor(app, hermes, 'andra_atagande', {
      identifier: id,
      villkor: [
        {
          text: 'Gör X endast om Y håller',
          kalla: { typ: 'beslut', id: '153' },
          galler: 'utfora',
          kontroll: 'kontrollera Y i redovisningen',
          utfall: 'uppfyllt',
        },
      ],
    });
    expect(utanBelagg.status).toBe(400);
  });

  // ---- 11. momentloggen mäter arbete, inte påståenden -------------------
  it('momentets aktör tas ur nyckeln, och historiska rader räknas inte', async () => {
    const id = await nyttArende(app, hermes, 'Moment');

    await kor(app, david, 'logga_moment', { moment: 'avgora_riktning', identifier: id });
    await kor(app, hermes, 'logga_moment', { moment: 'utfora', identifier: id });
    // Den historiska raden ligger MITT I mätfönstret. Det är avsiktligt: låg
    // den utanför skulle datumfiltret ensamt utesluta den, och provet hade
    // varit grönt även om historisk-filtret togs bort. (Motprovet 2026-09-09
    // visade precis det felet i en tidigare version av det här testet.)
    await kor(app, hermes, 'logga_moment', {
      moment: 'avgora_riktning',
      identifier: id,
      historisk: { aktor_typ: 'manniska', aktor_namn: 'david', tidpunkt: '2026-09-05T09:00:00Z' },
    });

    const { rows } = await pool.query<{ aktor_typ: string; aktor_namn: string; historisk: boolean }>(
      'SELECT aktor_typ, aktor_namn, historisk FROM arbetsmoment ORDER BY id',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ aktor_typ: 'manniska', aktor_namn: 'david', historisk: false });
    expect(rows[1]).toMatchObject({ aktor_typ: 'agent', aktor_namn: 'hermes', historisk: false });
    expect(rows[2]!.historisk).toBe(true);

    const andel = await kor(app, hermes, 'arbetsandel', {
      fran: '2026-09-01T00:00:00Z',
      till: '2027-01-01T00:00:00Z',
    });
    // Två observerade moment, ett av dem mänskligt. Den historiska raden ligger
    // i augusti OCH är märkt historisk — den får inte räknas.
    expect(andel.body.result.moment_totalt).toBe(2);
    expect(andel.body.result.moment_manniska).toBe(1);
    expect(andel.body.result.andel_manniska).toBe(50);
  });

  it('ingen observation ger ingen siffra — noll vore ett påstående', async () => {
    const andel = await kor(app, hermes, 'arbetsandel', {
      fran: '2020-01-01T00:00:00Z',
      till: '2020-01-02T00:00:00Z',
    });
    expect(andel.body.result.moment_totalt).toBe(0);
    expect(andel.body.result.andel_manniska).toBeNull();
  });

  // ---- 12. ett åtagande utan uppföljning blir liggande ------------------
  it('ett oavslutat åtagande kräver uppföljningstid', async () => {
    const id = await nyttArende(app, hermes, 'Utan uppföljning');
    const svar = await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: null,
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('uppfoljning_saknas');
  });

  // ---- 13. spärren i tjänstelagret, mätt för sig ------------------------
  //
  // "Genomfört utan belägg" hålls av TRE oberoende lager: zod-schemat i
  // registret, kontrollen i tjänsten och en CHECK i databasen. HTTP-provet
  // ovan mäter utfallet, och utfallet höll i motprovet 2026-09-09 även när
  // två av tre lager togs bort — bra för driften, men det betyder att provet
  // inte ensamt bevakar tjänstens spärr. Det här testet gör det: det kräver
  // den EXAKTA felkoden, så ett databasfel duger inte som grönt.
  it('tjänstens egen beläggsspärr svarar belagg_saknas — inte något annat fel', async () => {
    const id = await nyttArende(app, hermes, 'Tjänstelagrets spärr');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    await kor(app, hermes, 'ta_over_atagande', { identifier: id, nasta: INTERNT, foljs_upp: SEN });

    const fel = await withTransaction(async (client) => {
      try {
        await redovisaResultat(client, TENANT_ID, {
          identifier: id,
          sammanfattning: 'Utan belägg',
          belagg: [],
        });
        return null;
      } catch (e) {
        return e as { code?: string; status?: number };
      }
    });
    expect(fel).not.toBeNull();
    expect(fel!.code).toBe('belagg_saknas');
    expect(fel!.status).toBe(400);
  });

  it('ett åtagande utan grund är en gissning och avvisas', async () => {
    const id = await nyttArende(app, hermes, 'Utan grund');
    const svar = await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: [],
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    expect(svar.status).toBe(400);
  });
});
