-- KRAV-9: fritextsök över ärenden och kommentarer.
--
-- regconfig 'simple' (inte 'swedish'): arkivet blandar svensk och engelsk text i
-- samma fält, och svensk stemming ger oförutsägbara träffar på engelska termer.
-- 'simple' normaliserar bara till gemener utan stamning — ordet man söker är
-- ordet som matchar.

ALTER TABLE issues
  ADD COLUMN sokvektor tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))
  ) STORED;

CREATE INDEX issues_sok_idx ON issues USING gin (sokvektor);

ALTER TABLE comments
  ADD COLUMN sokvektor tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body, ''))) STORED;

CREATE INDEX comments_sok_idx ON comments USING gin (sokvektor);
