-- K-3: förälder/barn. 121 av arkivets 312 ärenden (39 %) låg under 23 föräldrar
-- i Linear — en sändkö med 21 barn och tolv personkort med 4–5 var — och hela
-- den strukturen tappades i importen eftersom kolumnen inte fanns.
--
-- Linears modell: ETT ärende har HÖGST EN förälder. Därför en självrefererande
-- kolumn på issues, inte en kanttabell.

ALTER TABLE issues ADD COLUMN foralder_id uuid REFERENCES issues(id);

-- Ett ärende kan inte vara sitt eget delärende. I praktiken är det triggern
-- nedan som svarar — BEFORE-triggrar körs före CHECK-villkoren, och den fångar
-- självfallet som kedjans kortaste cykel. CHECK:en står kvar som deklarativ
-- botten: den syns i \d issues och gäller även om triggern någon gång stängs av.
ALTER TABLE issues
  ADD CONSTRAINT issues_ingen_sjalvforalder
  CHECK (foralder_id IS NULL OR foralder_id <> id);

CREATE INDEX issues_foralder_idx ON issues (foralder_id) WHERE foralder_id IS NOT NULL;

-- Cykelspärr. Utan den kan en kedja bli cirkulär, och då snurrar varje
-- vandring uppåt (vyn, brödsmulan, en framtida rekursiv fråga) för alltid.
-- Arkivet är tre nivåer djupt i dag; taket på 100 steg är en broms, inte en
-- gräns för hur djupt någon får bygga.
CREATE FUNCTION issues_vagra_foralderscykel() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  nuvarande uuid := NEW.foralder_id;
  steg int := 0;
BEGIN
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

CREATE TRIGGER issues_ingen_foralderscykel
  BEFORE INSERT OR UPDATE OF foralder_id ON issues
  FOR EACH ROW WHEN (NEW.foralder_id IS NOT NULL)
  EXECUTE FUNCTION issues_vagra_foralderscykel();
