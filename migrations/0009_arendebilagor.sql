-- K-3: bilagor. 50 stycken på 28 ärenden i arkivet — dokumentlänkarna till de
-- dokument som faktiskt skickats till personerna. 21 av de 28 är personkorten
-- (LOC-78..98). Trettio av länkarna finns ingen annanstans i systemet: går de
-- förlorade finns dokumenten kvar i Google Drive men ingen väg tillbaka till
-- dem från ärendet. Det är Davids fråga från 19/8.
--
-- Bilagan är en LÄNK, inte en fil: plattformen lagrar aldrig innehållet.

CREATE TABLE issue_attachments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  issue_id   uuid NOT NULL REFERENCES issues(id),
  titel      text NOT NULL,
  -- Endast absolut http/https (HttpUrlSchema vid skrivningen, sakerUrl vid
  -- renderingen). Databasen bär ingen egen schemakontroll: en CHECK på text
  -- hade varit en halv sanning som inbjuder till att lita på den.
  url        text NOT NULL,
  undertitel text,
  -- Idempotensnyckel: 'linear-arkiv:LOC-227|bilaga|<url>'.
  source_ref text,
  skapad     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT issue_attachments_url_unik UNIQUE (issue_id, url),
  CONSTRAINT issue_attachments_source_ref_unik UNIQUE (source_ref)
);

CREATE INDEX issue_attachments_tenant_idx ON issue_attachments (tenant_id);
CREATE INDEX issue_attachments_issue_idx ON issue_attachments (issue_id, skapad);

GRANT SELECT, INSERT ON issue_attachments TO app;
