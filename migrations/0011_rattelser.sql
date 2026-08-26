-- K-1: rättningsvägar. Davids beslut #64 — läsvyns avgränsning bryts MED AVSIKT
-- så att information kan fyllas på och fel kan rättas.
--
-- Före den här migrationen var varje skrivning permanent: app-rollen hade
-- INSERT + SELECT och ingenting annat. En felstavad etikett, ett felaktigt
-- projektnamn, en kommentar med fel innehåll eller en läckt nyckel gick inte
-- att åtgärda inifrån systemet — bara med psql som ägare, alltså utan spår.
--
-- Principen här är INTE "släpp fram UPDATE/DELETE". Den är:
--   RÄTTA får man. RADERA HISTORIK får man inte.
--
-- Därför:
--   * events är OFÖRÄNDRAD — append-only, ingen ny rättighet, ingen ny trigger.
--     Den är proveniensankaret och varje rättelse nedan skriver en rad DIT.
--   * comments raderas MJUKT (borttagen-flagga). Texten finns kvar, händelsen
--     bär det gamla värdet, och en felaktig borttagning går att ångra.
--   * issue_labels raderas HÅRT. Raden är en ren kopplingsrad utan eget
--     innehåll — hela dess värde ("ärende X bar etikett Y") ryms i
--     händelseraden, och en mjuk flagga hade tvingat fram ett borttagen-filter
--     i varje etikettfråga i systemet till noll vinst.
--   * projects/labels får byta NAMN, inte försvinna. Ett felstavat namn är ett
--     stavfel; att radera ett projekt är en annan handling med följder för
--     ärendena, och den rätten ges inte här.
--   * api_keys får återkallas (aktiv = false), aldrig raderas: raden är
--     aktörens identitet och historiken pekar på namnet.

-- ---------------------------------------------------------------------------
-- 1. Kommentarer: mjuk radering
-- ---------------------------------------------------------------------------

ALTER TABLE comments ADD COLUMN borttagen timestamptz;

-- Läsvägarna filtrerar på borttagen IS NULL. Partiellt index så att den
-- filtreringen inte kostar en seq scan när arkivet växer.
CREATE INDEX comments_synliga_idx ON comments (tenant_id, issue_id, skapad)
  WHERE borttagen IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Proveniensen är INTE rättbar
-- ---------------------------------------------------------------------------
--
-- Att öppna UPDATE på comments utan den här spärren hade återskapat exakt den
-- smärta hela plattformen byggdes mot: "agentkommentarer stämplas David".
-- En agent hade kunnat skriva en kommentar och sedan sätta om aktor_namn.
--
-- TVÅ försvarslinjer, precis som för events (migration 0004) — och de är
-- oberoende av varandra, så att ingen av dem kan tas bort i skydd av den andra:
--
--   1. KOLUMN-GRANT nedan: app-rollen får skriva body och borttagen. Inte
--      aktor_typ, inte aktor_namn, inte issue_id, inte skapad, inte source_ref.
--      Ett försök ger 42501 (insufficient_privilege).
--   2. TRIGGERN: gäller ÄVEN tabellägaren, som går förbi GRANT-nivån.
--      Ett försök ger P0001.

CREATE FUNCTION comments_skydda_proveniens() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id         IS DISTINCT FROM OLD.id
  OR NEW.tenant_id  IS DISTINCT FROM OLD.tenant_id
  OR NEW.issue_id   IS DISTINCT FROM OLD.issue_id
  OR NEW.aktor_typ  IS DISTINCT FROM OLD.aktor_typ
  OR NEW.aktor_namn IS DISTINCT FROM OLD.aktor_namn
  OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
  OR NEW.skapad     IS DISTINCT FROM OLD.skapad THEN
    RAISE EXCEPTION
      'kommentarens proveniens är oföränderlig: bara body och borttagen får ändras';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER comments_proveniens_orubblig
  BEFORE UPDATE ON comments
  FOR EACH ROW EXECUTE FUNCTION comments_skydda_proveniens();

-- DELETE ges ALDRIG på comments: en kommentar försvinner inte ur historiken,
-- den markeras borttagen. Raden nedan är uttrycklig så att en bred GRANT i en
-- framtida migration inte kan smyga in rätten.
REVOKE DELETE ON comments FROM app;

GRANT UPDATE (body, borttagen) ON comments TO app;

-- ---------------------------------------------------------------------------
-- 3. Etikett av ett ärende: hård borttagning
-- ---------------------------------------------------------------------------

GRANT DELETE ON issue_labels TO app;

-- ---------------------------------------------------------------------------
-- 4. Rätta ett felstavat namn — men inte radera objektet
-- ---------------------------------------------------------------------------

GRANT UPDATE (namn) ON projects TO app;
GRANT UPDATE (namn) ON labels TO app;

-- ---------------------------------------------------------------------------
-- 5. Återkalla en nyckel
-- ---------------------------------------------------------------------------
--
-- Kolumn-GRANT: bara `aktiv`. Nyckelhashen, aktörstypen och aktörsnamnet på en
-- utfärdad nyckel går inte att skriva om — annars hade en återkallad nyckel
-- kunnat döpas om till en giltig aktör i efterhand.

GRANT UPDATE (aktiv) ON api_keys TO app;
