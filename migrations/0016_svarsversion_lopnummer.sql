-- FR-3/FR-17, svarsslingan Story 4.7: löpnumret identifierar svarstillfället,
-- hashen kontrollerar innehållet. A → B → A får tre olika versioner.
-- Befintliga rader står kvar med version NULL som historik. Den äldre
-- klientens anrop identifieras fortfarande av hashen bland dessa rader.
ALTER TABLE beslut_svarsversion ADD COLUMN version integer;
ALTER TABLE beslut_svarsversion DROP CONSTRAINT beslut_svarsversion_unik;
ALTER TABLE beslut_svarsversion ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY;

CREATE UNIQUE INDEX beslut_svarsversion_lopnummer
  ON beslut_svarsversion (tenant_id, beslut_id, version) WHERE version IS NOT NULL;
CREATE UNIQUE INDEX beslut_svarsversion_hash_utan_version
  ON beslut_svarsversion (tenant_id, beslut_id, svar_hash) WHERE version IS NULL;
