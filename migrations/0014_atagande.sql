-- Åtagandet: ett ärende som bär ett utlovat resultat, grunden för arbetet och
-- vem som måste göra nästa insats. Specen: Astra 2026-09-09, avsnitt 1–3.
-- Ramen: ägare ger riktning, användaren bär utgången till verkligheten,
-- Hermes är bolaget och gör allt annat självt.
--
-- Tre invarianter tvingas i schemat, inte i dokumentationen:
--   1. Ett åtagande kan inte bli "övertaget" utan att en verklig aktör står
--      där. Aktören sätts av actionlagret ur API-nyckeln, aldrig ur indata.
--   2. Ett åtagande kan inte bli "genomfört" utan resultat med belägg.
--   3. Samma svarsversion kan inte tillämpas två gånger (unik nyckel), så en
--      omkörning skapar aldrig dubbelarbete.

-- ---------------------------------------------------------------- åtagandet
ALTER TABLE issues ADD COLUMN atagande_lage text
  CHECK (atagande_lage IN ('registrerat','overtaget','hindrat','genomfort','avslutat'));
ALTER TABLE issues ADD COLUMN atagande_tillhor text
  CHECK (atagande_tillhor IN ('agare','anvandare','hermes'));

-- Utföraren skrivs ENBART av övertagande-actionen, ur aktören i API-nyckeln.
-- En adress i en överlämningsfil är ingen utförare.
ALTER TABLE issues ADD COLUMN atagande_utforare_typ text
  CHECK (atagande_utforare_typ IN ('manniska','agent','system'));
ALTER TABLE issues ADD COLUMN atagande_utforare_namn text;
ALTER TABLE issues ADD COLUMN atagande_overtaget_nar timestamptz;

-- Hermes nästa skyldighet att kontrollera framdrift. Skilt från due_date, som
-- är ett verkligt leveransdatum mot omvärlden.
ALTER TABLE issues ADD COLUMN atagande_foljs_upp timestamptz;
ALTER TABLE issues ADD COLUMN atagande_revision integer NOT NULL DEFAULT 0;

-- Resten av åtagandet: grund[], nasta{}, villkor[], hinder{}, resultat{},
-- avslutsskal{}, utfall_precisering. Validerat i tjänstelagret med zod.
ALTER TABLE issues ADD COLUMN atagande jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Ett åtagande utan läge finns inte: alla åtagandefält kräver läget, och
-- läget kräver att någon grund finns. Ett tomt åtagande är inte ett åtagande.
ALTER TABLE issues ADD CONSTRAINT issues_atagande_helhet CHECK (
  (atagande_lage IS NULL AND atagande_tillhor IS NULL)
  OR (atagande_lage IS NOT NULL AND atagande_tillhor IS NOT NULL
      AND jsonb_array_length(COALESCE(atagande->'grund','[]'::jsonb)) >= 1)
);

-- Övertaget utan utförare är den lögn specen förbjuder. Spärras i schemat.
ALTER TABLE issues ADD CONSTRAINT issues_atagande_overtagande CHECK (
  atagande_lage <> 'overtaget'
  OR (atagande_utforare_namn IS NOT NULL AND atagande_overtaget_nar IS NOT NULL)
);

-- Genomfört utan resultat med belägg är den andra lögnen.
ALTER TABLE issues ADD CONSTRAINT issues_atagande_resultat CHECK (
  atagande_lage <> 'genomfort'
  OR (atagande ? 'resultat'
      AND jsonb_array_length(COALESCE(atagande->'resultat'->'belagg','[]'::jsonb)) >= 1)
);

-- Hindrat utan angiven orsak döljer ett stillestånd.
ALTER TABLE issues ADD CONSTRAINT issues_atagande_hinder CHECK (
  atagande_lage <> 'hindrat' OR atagande ? 'hinder'
);

-- Avslutat utan belagt skäl kan dölja ett nej som en leverans.
ALTER TABLE issues ADD CONSTRAINT issues_atagande_avslut CHECK (
  atagande_lage <> 'avslutat' OR atagande ? 'avslutsskal'
);

CREATE INDEX issues_atagande_lage_idx ON issues (tenant_id, atagande_lage)
  WHERE atagande_lage IS NOT NULL;
CREATE INDEX issues_atagande_foljs_upp_idx ON issues (tenant_id, atagande_foljs_upp)
  WHERE atagande_lage IS NOT NULL AND atagande_lage NOT IN ('genomfort','avslutat');

-- --------------------------------------------------- beslut → åtagande
-- Ett beslut har högst ETT huvudåtagande. Unik nyckel gör omkörning ofarlig:
-- routern kan avbrytas mitt i utan att skapa arbete två gånger.
CREATE TABLE beslut_atagande (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  beslut_id  integer NOT NULL,
  issue_id   uuid NOT NULL REFERENCES issues(id),
  skapad     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beslut_atagande_unik PRIMARY KEY (tenant_id, beslut_id)
);
CREATE INDEX beslut_atagande_issue_idx ON beslut_atagande (issue_id);
GRANT SELECT, INSERT, DELETE ON beslut_atagande TO app;

-- ------------------------------------------------ behandlade svarsversioner
-- Innehållshashen är av det EXAKTA svaret. En komplettering ger en ny hash och
-- därmed ett nytt tillfälle att handla; samma text kan aldrig ge två.
CREATE TABLE beslut_svarsversion (
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  beslut_id   integer NOT NULL,
  svar_hash   text NOT NULL,
  issue_id    uuid REFERENCES issues(id),
  tillampad   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT beslut_svarsversion_unik PRIMARY KEY (tenant_id, beslut_id, svar_hash)
);
GRANT SELECT, INSERT ON beslut_svarsversion TO app;

-- ------------------------------------------------------------- momentloggen
-- Prov 6 mäter Davids arbetsandel. Den kan inte mätas i efterhand och får inte
-- läsa en proxy: därför skrivs varje moment när det händer, med belägg.
-- Momentindelningen är låst i baslinje-2026-09-09.md och ändras inte.
CREATE TABLE arbetsmoment (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  issue_id   uuid REFERENCES issues(id),
  beslut_id  integer,
  moment     text NOT NULL CHECK (moment IN
             ('hitta_underlag','avgora_riktning','forbereda',
              'utfora','kontrollera','folja_upp')),
  aktor_typ  text NOT NULL CHECK (aktor_typ IN ('manniska','agent','system')),
  aktor_namn text NOT NULL,
  belagg     jsonb NOT NULL DEFAULT '{}',
  historisk  boolean NOT NULL DEFAULT false,
  tidpunkt   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX arbetsmoment_tid_idx ON arbetsmoment (tenant_id, tidpunkt DESC);
CREATE INDEX arbetsmoment_issue_idx ON arbetsmoment (issue_id, tidpunkt);

-- Samma append-only-skydd som events: ett moment får inte skrivas om i efterhand.
CREATE TRIGGER arbetsmoment_ingen_update_delete
  BEFORE UPDATE OR DELETE ON arbetsmoment
  FOR EACH ROW EXECUTE FUNCTION events_blockera_mutation();
CREATE TRIGGER arbetsmoment_ingen_truncate
  BEFORE TRUNCATE ON arbetsmoment
  FOR EACH STATEMENT EXECUTE FUNCTION events_blockera_mutation();
REVOKE UPDATE, DELETE, TRUNCATE ON arbetsmoment FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON arbetsmoment FROM app;
GRANT SELECT, INSERT ON arbetsmoment TO app;
