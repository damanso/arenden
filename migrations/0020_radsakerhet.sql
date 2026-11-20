-- FR-25, FR-3, B-27, Story 9.2: databasen håller tenantgränsen även när en
-- fråga glömt sitt filter. Del 1 ger två begränsade uppslag före tenantvalet.
-- Del 2 aktiverar radsäkerheten på varje tenantbunden tabell ur katalogen.
-- Ägaren kringgår skyddet (ingen FORCE); app gör det inte.

-- Nyckeln slås upp innan tenanten är känd. B-27 ger app bara funktionernas
-- begränsade läsväg utan tenant.
CREATE FUNCTION nyckelns_aktor(p_nyckelhash text)
RETURNS TABLE (aktor_typ text, aktor_namn text, tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT k.aktor_typ, k.aktor_namn, k.tenant_id
    FROM api_keys k
   WHERE k.nyckelhash = p_nyckelhash AND k.aktiv
$$;
REVOKE ALL ON FUNCTION nyckelns_aktor(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nyckelns_aktor(text) TO app;

CREATE FUNCTION aktorens_tenanter(p_aktor_typ text, p_aktor_namn text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT k.tenant_id
    FROM api_keys k
   WHERE k.aktor_typ = p_aktor_typ AND k.aktor_namn = p_aktor_namn
$$;
REVOKE ALL ON FUNCTION aktorens_tenanter(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aktorens_tenanter(text, text) TO app;

-- Katalogen väljer tabellerna (B-27). En senare migration som skapar en tabell
-- med tenant_id lägger dess policy själv; annars fälls den av S7.
DO $$
DECLARE
  tabell record;
  antal integer := 0;
  uttryck text := $u$tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid$u$;
BEGIN
  FOR tabell IN
    SELECT t.relname
      FROM pg_class t
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relkind IN ('r', 'p')
       AND EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = t.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
       )
     ORDER BY t.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tabell.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolering ON public.%I FOR ALL TO app USING (%s) WITH CHECK (%s)',
      tabell.relname, uttryck, uttryck
    );
    antal := antal + 1;
  END LOOP;
  IF antal = 0 THEN
    RAISE EXCEPTION 'Inga tabeller med tenant_id hittades; radsäkerheten kunde inte införas.';
  END IF;
END
$$;
