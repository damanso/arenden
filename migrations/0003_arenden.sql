-- KRAV-7: projekt, etiketter, ärenden och kommentarer.
--
-- identifier ('LOC-330') lagras INTE — den härleds som team.key || '-' ||
-- sequence_number i frågorna, så att den aldrig kan divergera från sina delar.
-- Unikheten som betyder något ligger på (team_id, sequence_number).

CREATE TABLE projects (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  namn      text NOT NULL,
  skapad    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_namn_unik UNIQUE (tenant_id, namn)
);

CREATE INDEX projects_tenant_idx ON projects (tenant_id);

CREATE TABLE labels (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  namn      text NOT NULL,
  skapad    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT labels_namn_unik UNIQUE (tenant_id, namn)
);

CREATE INDEX labels_tenant_idx ON labels (tenant_id);

CREATE TABLE issues (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  team_id         uuid NOT NULL REFERENCES teams(id),
  project_id      uuid REFERENCES projects(id),
  state_id        uuid NOT NULL REFERENCES workflow_states(id),
  sequence_number integer NOT NULL,
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  -- Linears skala: 1 = brådskande … 4 = låg. NULL = ingen prioritet satt.
  priority        integer CHECK (priority BETWEEN 1 AND 4),
  due_date        date,
  -- Namnet på den agent/människa som plockat ärendet ur kön (claim_next_issue).
  claimad_av      text,
  -- Idempotensnyckeln från CRM-kontraktet: 'linear-arkiv:LOC-316'.
  source_ref      text,
  skapad          timestamptz NOT NULL DEFAULT now(),
  uppdaterad      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT issues_nummer_unik UNIQUE (team_id, sequence_number),
  CONSTRAINT issues_source_ref_unik UNIQUE (source_ref)
);

CREATE INDEX issues_tenant_idx ON issues (tenant_id);
CREATE INDEX issues_state_idx ON issues (state_id);
CREATE INDEX issues_project_idx ON issues (project_id);
-- Agentkön (claim_next_issue) ordnar oclaimade ärenden på prioritet + ålder.
CREATE INDEX issues_ko_idx ON issues (tenant_id, priority, skapad) WHERE claimad_av IS NULL;
CREATE INDEX issues_lista_idx ON issues (tenant_id, skapad DESC, id DESC);

CREATE TABLE issue_labels (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  issue_id  uuid NOT NULL REFERENCES issues(id),
  label_id  uuid NOT NULL REFERENCES labels(id),
  PRIMARY KEY (issue_id, label_id)
);

CREATE INDEX issue_labels_tenant_idx ON issue_labels (tenant_id);
CREATE INDEX issue_labels_label_idx ON issue_labels (label_id);

CREATE TABLE comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  issue_id   uuid NOT NULL REFERENCES issues(id),
  body       text NOT NULL,
  -- Proveniens per skrivning (AI Act art 50): vem som faktiskt skrev raden.
  aktor_typ  text NOT NULL CHECK (aktor_typ IN ('manniska', 'agent', 'system')),
  aktor_namn text NOT NULL,
  source_ref text,
  skapad     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comments_source_ref_unik UNIQUE (source_ref)
);

CREATE INDEX comments_tenant_idx ON comments (tenant_id);
CREATE INDEX comments_issue_idx ON comments (issue_id, skapad);

GRANT SELECT, INSERT ON projects TO app;
GRANT SELECT, INSERT ON labels TO app;
GRANT SELECT, INSERT, UPDATE ON issues TO app;
GRANT SELECT, INSERT ON issue_labels TO app;
GRANT SELECT, INSERT ON comments TO app;
