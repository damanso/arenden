-- K-4: ärende → kund, med ID och inte med namn.
--
-- Bakgrunden: kopplingen projekt → organisation har hittills varit en
-- HÅRDKODAD femradstabell (PROJEKT_TILL_ORG) i två kopior, ett namnpar per rad.
-- Namnmatchning är en PROXY för identitet. Den ljuger tyst: en exakt
-- namnmatchning projects.namn -> crm.organizations.name ger 3 av 3 träffar
-- inklusive "Hermes" — och den CRM-organisationen är arkiverad, har noll
-- interaktioner och noll personer. 33 ärenden hade knutits till en tom post
-- utan att något sett fel ut.
--
-- Därför: en EXPLICIT koppling med id.
--
--   kund_id      = redovisningens customers.id (uuid).
--   kund_kalla   = vilket system id:t hör hemma i. Ett id utan sitt system är
--                  inte ett id, det är 16 slumpbytes.
--
-- INGEN främmande nyckel: redovisningen är en ANNAN databas i en annan
-- container. En FK hade gjort ärendeplattformen beroende av att redovisningen
-- lever, och de tre systemen ska kunna leva helt oberoende av varandra.
-- Kolumnen är därför nullbar och ovaliderad mot måldatabasen — avstämningen
-- görs av ett prov (scripts/prov_kundkoppling.py), inte av en constraint.

ALTER TABLE projects
  ADD COLUMN kund_id uuid,
  ADD COLUMN kund_kalla text,
  ADD COLUMN kund_kopplad_at timestamptz,
  -- Tre lägen, inte två. En ensam NULL i kund_id kan betyda två helt olika
  -- saker — "internt projekt, ska ALDRIG kopplas" och "vi vet inte än" — och
  -- ett fält som betyder två saker är samma sorts tyst lögn som namnmatchningen.
  --   intern    = internt projekt (Hermes, Locollabs ...). Kopplas aldrig.
  --   kopplad   = kund_id är satt och avgjord.
  --   oavgjord  = ingen har avgjort saken än. STARTLÄGET.
  ADD COLUMN koppling_status text NOT NULL DEFAULT 'oavgjord';

ALTER TABLE projects
  ADD CONSTRAINT projects_koppling_status_check
    CHECK (koppling_status IN ('kopplad', 'intern', 'oavgjord'));

-- Regeln, i databasen och inte bara i koden: 'kopplad' KRÄVER både id och
-- källa, och de två andra lägena FÖRBJUDER dem. Ett halvfyllt par kan alltså
-- inte existera, och ingen kan sätta status='intern' med ett kund_id kvar.
ALTER TABLE projects
  ADD CONSTRAINT projects_koppling_komplett_check
    CHECK (
      (koppling_status = 'kopplad'
        AND kund_id IS NOT NULL AND kund_kalla IS NOT NULL AND kund_kopplad_at IS NOT NULL)
      OR
      (koppling_status <> 'kopplad'
        AND kund_id IS NULL AND kund_kalla IS NULL AND kund_kopplad_at IS NULL)
    );

CREATE INDEX projects_kund_idx ON projects (tenant_id, kund_id) WHERE kund_id IS NOT NULL;

COMMENT ON COLUMN projects.kund_id IS
  'redovisningens customers.id. Nullbar, utan FK (annan databas) — avstämd av prov, inte av constraint.';
COMMENT ON COLUMN projects.kund_kalla IS
  'Vilket system kund_id hör hemma i, t.ex. redovisning.';
COMMENT ON COLUMN projects.koppling_status IS
  'kopplad | intern | oavgjord. Skiljer "ska aldrig kopplas" från "inte avgjort än".';
