-- KRAV-5 + KRAV-6: team med egen nummersekvens och arbetsflödesstatusar.

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key         text NOT NULL,
  namn        text NOT NULL,
  -- Namnet på teamets dedikerade sekvens (skapad av skapa_arendesekvens).
  sekvensnamn text NOT NULL,
  skapad      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_key_unik UNIQUE (key),
  CONSTRAINT teams_key_format CHECK (key ~ '^[A-Z][A-Z0-9]{0,9}$')
);

CREATE INDEX teams_tenant_idx ON teams (tenant_id);

CREATE TABLE workflow_states (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  team_id   uuid NOT NULL REFERENCES teams(id),
  namn      text NOT NULL,
  typ       text NOT NULL CHECK (typ IN ('backlog', 'unstarted', 'started', 'completed', 'canceled')),
  position  integer NOT NULL,
  CONSTRAINT workflow_states_namn_unik UNIQUE (team_id, namn)
);

CREATE INDEX workflow_states_tenant_idx ON workflow_states (tenant_id);
CREATE INDEX workflow_states_team_idx ON workflow_states (team_id, position);

GRANT SELECT, INSERT ON teams TO app;
GRANT SELECT, INSERT ON workflow_states TO app;
