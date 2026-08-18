-- Grunden: applikationsroll, tenant och hjälpfunktionen för ärendesekvenser.
-- Körs som ägarrollen via DATABASE_ADMIN_URL (npm run migrate).
--
-- gen_random_uuid() är inbyggd i Postgres 13+ — ingen extension behövs.

-- Applikationsrollen: API:t ansluter som "app" — icke-superuser och inte
-- tabellägare (KRAV-3). Rättigheter GRANT:as uttryckligen per tabell nedan och
-- i följande migrationer; det som aldrig GRANT:as finns inte.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN;
  END IF;
END
$$;

-- KRAV-4: varje tabell bär tenant_id. Etapp 1 kör EN fast tenant; RLS-policyer
-- är Etapp 3 och byggs inte nu — kolumnen och indexen finns från dag 1 så att
-- policyerna kan läggas på utan datamigrering.
CREATE TABLE tenants (
  id     uuid PRIMARY KEY,
  namn   text NOT NULL,
  skapad timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenants (id, namn)
VALUES ('00000000-0000-0000-0000-000000000001', 'Locollabs AB')
ON CONFLICT (id) DO NOTHING;

GRANT SELECT ON tenants TO app;

-- KRAV-5: varje team får en DEDIKERAD sekvens för sina ärendenummer, så att
-- issues.sequence_number sätts med nextval i create-transaktionen — aldrig
-- MAX+1 (som kapplöper). app-rollen får inte skapa objekt i schemat; därför
-- skapas sekvensen av den här SECURITY DEFINER-funktionen, som validerar
-- nyckeln själv (andra försvarslinjen mot injektion i ett identifierarnamn).
CREATE FUNCTION skapa_arendesekvens(p_key text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_namn text;
BEGIN
  IF p_key !~ '^[A-Z][A-Z0-9]{0,9}$' THEN
    RAISE EXCEPTION 'ogiltig teamnyckel: %', p_key;
  END IF;
  v_namn := 'arende_nummer_' || lower(p_key);
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS %I', v_namn);
  EXECUTE format('GRANT USAGE, SELECT, UPDATE ON SEQUENCE %I TO app', v_namn);
  RETURN v_namn;
END
$$;

REVOKE ALL ON FUNCTION skapa_arendesekvens(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION skapa_arendesekvens(text) TO app;
