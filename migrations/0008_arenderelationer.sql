-- K-3: relationer mellan ärenden. 71 unika par i arkivet, varav 5 'blocks'
-- (kedjan LOC-201 → 202 → 203 → 212). Importen hade ingenstans att lägga dem.
--
-- EN rad per relation, precis som Linear lagrar den. Motriktningen härleds i
-- läsfrågan (relationerFor) — lagras den också blir de två raderna med tiden
-- oense om varandra.

CREATE TABLE issue_relations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  fran_issue_id uuid NOT NULL REFERENCES issues(id),
  till_issue_id uuid NOT NULL REFERENCES issues(id),
  -- 'related' är symmetrisk, 'blocks' är riktad: från blockerar till.
  typ           text NOT NULL CHECK (typ IN ('related', 'blocks')),
  -- Idempotensnyckeln, samma mönster som issues/comments:
  -- 'linear-arkiv:LOC-201|blocks|LOC-202'.
  source_ref    text,
  skapad        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT issue_relations_ingen_sjalvrelation CHECK (fran_issue_id <> till_issue_id),
  CONSTRAINT issue_relations_unik UNIQUE (fran_issue_id, till_issue_id, typ),
  CONSTRAINT issue_relations_source_ref_unik UNIQUE (source_ref)
);

CREATE INDEX issue_relations_tenant_idx ON issue_relations (tenant_id);
CREATE INDEX issue_relations_fran_idx ON issue_relations (fran_issue_id);
CREATE INDEX issue_relations_till_idx ON issue_relations (till_issue_id);

-- 'related' är SYMMETRISK: A–B och B–A är samma relation. UNIQUE-villkoret
-- ovan är riktat och hade släppt igenom båda raderna — då hade ärendesidan
-- visat samma relation två gånger och en borttagning bara tagit hälften.
-- Det normaliserade paret gör dubbletten omöjlig i databasen, inte i koden.
CREATE UNIQUE INDEX issue_relations_symmetrisk_unik
  ON issue_relations (least(fran_issue_id, till_issue_id), greatest(fran_issue_id, till_issue_id))
  WHERE typ = 'related';

GRANT SELECT, INSERT ON issue_relations TO app;
