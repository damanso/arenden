-- FR-28, B-10 (Story 6.4): ärendehierarkin kan inte bli cirkulär, ens vid samtidiga ändringar.
--
-- Kodgranskningens fynd: cykelspärren issues_vagra_foralderscykel (0007) vandrar förälderkedjan utan
-- lås. Två samtidiga ändringar, A under B och B under A, kan därför båda se det gamla läget och båda
-- godtas, och då är hierarkin cirkulär. Oftare slutar fallet i ett dödläge (40P01): var och en håller
-- radlåset på sitt eget ärende och väntar på det delade låset som främmande nyckeln foralder_id tar på
-- den nya föräldern, och Postgres avbryter den ena. 40P01 översätts inte, så svaret blir 500.
--
-- Rättelsen serialiserar förälderbytena per tenant med ett rådgivande transaktionslås:
--   1. Låsnyckeln definieras BARA här, i issues_ta_hierarkilas. Triggerfunktionen nedan och
--      tjänstelagret (uppdateraArendeFalt, före radlåset) anropar båda funktionen och skriver aldrig
--      nyckeln själva, så de tar alltid samma lås.
--   2. Triggerfunktionen tar låset bara när raden får eller byter förälder, och vandrar kedjan först
--      därefter (IR-01, varv 2). uppdateraArendeFalt sätter foralder_id i varje UPDATE, så triggern körs
--      också för en titelrättelse på ett ärende med förälder. Hade den låst då, hade den tagit låset
--      EFTER radlåset och kunnat vänta på det medan en förälderändring väntar på samma radlås (40P01).
--      En rad vars förälder inte byts kan inte skapa en cykel, så vandringen behövs inte heller.
--   3. Ingen tabell ändras. Triggern issues_ingen_foralderscykel står kvar och pekar på samma funktion,
--      som skrivs om med CREATE OR REPLACE. Cykelfelet är detsamma: samma två meddelanden (P0001).
--   4. Ett skript utanför appen som byter förälder (ägarrollen, med en direkt UPDATE eller INSERT) anropar
--      issues_ta_hierarkilas först i sin transaktion, innan det låser eller skriver någon rad i issues.
--      Annars låser skriptet raden (FOR NO KEY UPDATE) innan triggern begär hierarkilåset. Håller då
--      update_issue med parent på samma rad redan hierarkilåset och väntar på radlåset (FOR UPDATE), blir
--      det ett dödläge (40P01) som inte fanns före den här migrationen; före den väntade triggern inte på
--      något. Appens låsordning ändras inte: uppdateraArendeFalt tar redan låset före radlåset.

-- Hierarkilåset för en tenant. Tvåheltalsformen: den första nyckeln, 28064, står för FR-28 och
-- Story 6.4, den andra är tenanten. Formen med två heltal ligger i en annan nyckelrymd än
-- migrationernas eget lås (ett enda bigint-värde i src/db/migrate.ts), så de två kan aldrig krocka.
-- Låset hålls till transaktionens slut och kan tas igen i samma transaktion utan att vänta.
CREATE FUNCTION issues_ta_hierarkilas(p_tenant uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(28064, hashtext(p_tenant::text));
END
$$;

REVOKE ALL ON FUNCTION issues_ta_hierarkilas(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION issues_ta_hierarkilas(uuid) TO app;

-- Cykelspärren, omskriven. Vandringen, taket och meddelandena är desamma som i 0007.
CREATE OR REPLACE FUNCTION issues_vagra_foralderscykel() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  nuvarande uuid := NEW.foralder_id;
  steg int := 0;
BEGIN
  -- IR-01 (varv 2): en UPDATE som lämnar föräldern orörd varken låser eller vandrar.
  IF TG_OP = 'UPDATE' AND NEW.foralder_id IS NOT DISTINCT FROM OLD.foralder_id THEN
    RETURN NEW;
  END IF;

  -- Låset före vandringens första SELECT. Varje sats i funktionen får en ny ögonblicksbild
  -- (READ COMMITTED), så en transaktion som väntat på låset ser den förälderändring som den som
  -- höll låset just committade.
  PERFORM issues_ta_hierarkilas(NEW.tenant_id);

  WHILE nuvarande IS NOT NULL LOOP
    IF nuvarande = NEW.id THEN
      RAISE EXCEPTION 'förälderkedjan skulle bli cirkulär: ärendet kan inte ligga under sig självt';
    END IF;
    steg := steg + 1;
    IF steg > 100 THEN
      RAISE EXCEPTION 'förälderkedjan är orimligt djup (över 100 steg) — vägrar skriva';
    END IF;
    SELECT i.foralder_id INTO nuvarande FROM issues i WHERE i.id = nuvarande;
  END LOOP;
  RETURN NEW;
END
$$;
