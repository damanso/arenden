-- Insatsen: ETT bestämt stopp där arbetet behöver en människa.
-- Spec: Astra 2026-09-09 (02-Områden/hermes/enprodukt-analys-2026-09-09-astra.md §4).
--
-- David: "exempel på två av tre olika ställen som kräver mina svar ... Dessa
-- ska vara samlade." Fem köer, fem svarsvägar, ingen gemensam identitet.
--
-- Astras varning står i schemat, inte bara i texten: "Om sammanställningen
-- bara gör dem till likadana kort har vi byggt en ny inkorg ovanpå de gamla."
-- Därför bär varje insats sin KÄLLA och sin TYP, och typen avgör vilket
-- kommando som får utföras. Ett CRM-löfte, ett ägarbeslut och en
-- granskningsdom är olika saker.
--
-- Tre invarianter tvingas här:
--   1. Ett stopp = en insats. Unik nyckel på (tenant, stopp_id).
--   2. Ett källobjekt kan bara höra till EN insats. Unik nyckel på
--      (tenant, system, objekttyp, objekt_id). Det är spärren mot att samma
--      fråga dyker upp igen som löfte, beslut OCH briefrad.
--   3. Ett svar kräver en människa. Aktören tas ur nyckeln; en agentnyckel
--      kan inte bokföras som om David svarat.

CREATE TABLE insatser (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),

  -- Stoppet: vilket vantetillfalle i vilket arbete. Harleds ur arbetet, aldrig
  -- ur en rubrik, ett datum eller en listposition.
  stopp_id      text NOT NULL,
  issue_id      uuid REFERENCES issues(id),

  -- Vad slags mansklig medverkan. Typen styr vilket kommando som far koras.
  typ           text NOT NULL CHECK (typ IN
                ('agarbeslut','utathandling','kundkontakt','godkannande','intygande')),
  -- Vem den tillhor. `hermes` finns MED FLIT INTE: en insats som inte kraver
  -- en manniska ar inte en insats, den ar bolagets eget arbete.
  tillhor       text NOT NULL CHECK (tillhor IN ('agare','anvandare')),

  utfall            text NOT NULL,
  begard_handling   text NOT NULL,
  blockeringsgrund  text NOT NULL,
  belagg            jsonb NOT NULL DEFAULT '[]',

  frist         timestamptz,
  vackningstid  timestamptz,

  lage          text NOT NULL DEFAULT 'vantande'
                CHECK (lage IN ('vantande','uppskjuten','svar_mottaget','aterkallad','avslutad')),
  version       integer NOT NULL DEFAULT 1,

  -- Handlingskontraktet: vilket agarsystem som far utfora, med vilket kommando
  -- och mot vilket objekt. Ytan utfor ALDRIG sjalv -- den anropar agaren.
  handlingskontrakt jsonb NOT NULL DEFAULT '{}',

  -- Svaret och fortsattningen
  svar_text     text,
  svar_aktor    text,
  svar_nar      timestamptz,
  fortsattning  jsonb,

  skapad        timestamptz NOT NULL DEFAULT now(),
  uppdaterad    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT insatser_stopp_unik UNIQUE (tenant_id, stopp_id)
);

-- Ett svar utan aktor ar ingen manniskas svar.
ALTER TABLE insatser ADD CONSTRAINT insatser_svar_har_aktor CHECK (
  lage <> 'svar_mottaget' OR (svar_aktor IS NOT NULL AND svar_nar IS NOT NULL)
);
-- Uppskjutet utan vackningstid ar bortglomt, inte uppskjutet.
ALTER TABLE insatser ADD CONSTRAINT insatser_uppskjuten_har_tid CHECK (
  lage <> 'uppskjuten' OR vackningstid IS NOT NULL
);

CREATE INDEX insatser_kon_idx ON insatser (tenant_id, lage, tillhor, frist);
CREATE INDEX insatser_issue_idx ON insatser (issue_id);
GRANT SELECT, INSERT, UPDATE ON insatser TO app;

-- ----------------------------------------------------------- kallreferenser
-- Alla beslut, loften, domar och briefpunkter som beskriver SAMMA stopp.
-- Den unika nyckeln ar hela poangen: samma fraga kan komma fran fyra hall och
-- far anda bara EN insats. Textlikhet far foresla en koppling -- aldrig sla
-- ihop tva insatser.
CREATE TABLE insats_kallor (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  insats_id   uuid NOT NULL REFERENCES insatser(id) ON DELETE CASCADE,
  system      text NOT NULL,        -- hermes | redovisning | arenden
  objekttyp   text NOT NULL,        -- beslut | commitment | granskningsdom | briefpunkt | atagande
  objekt_id   text NOT NULL,
  objekt_version text,
  lank        text,
  skapad      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insats_kallor_unik PRIMARY KEY (tenant_id, system, objekttyp, objekt_id)
);
CREATE INDEX insats_kallor_insats_idx ON insats_kallor (insats_id);
GRANT SELECT, INSERT, DELETE ON insats_kallor TO app;
