-- KRAV-8: events är append-only revisionslogg och bär proveniensen.
--
-- Två försvarslinjer mot ändring/radering:
--   1. app-rollen får bara SELECT + INSERT (UPDATE/DELETE GRANT:as aldrig, och
--      REVOKE nedan gör det uttryckligt även om någon skulle GRANT:a brett).
--   2. Triggrar blockerar UPDATE/DELETE/TRUNCATE även för tabellägaren.
--
-- Varje mutation via actions skriver sin event-rad i SAMMA transaktion som
-- mutationen (se src/actions/execute.ts) — proveniens är ett förstaklasskrav,
-- och aktören tas ALLTID ur API-nyckeln, aldrig ur request-body.

CREATE TABLE events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  issue_id   uuid REFERENCES issues(id),
  aktor_typ  text NOT NULL CHECK (aktor_typ IN ('manniska', 'agent', 'system')),
  aktor_namn text NOT NULL,
  verb       text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  tidpunkt   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX events_tenant_idx ON events (tenant_id, tidpunkt DESC);
CREATE INDEX events_issue_idx ON events (issue_id, tidpunkt);

CREATE FUNCTION events_blockera_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events är append-only: % tillåts inte', TG_OP;
END
$$;

CREATE TRIGGER events_ingen_update_delete
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_blockera_mutation();

CREATE TRIGGER events_ingen_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_blockera_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON events FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON events FROM app;
GRANT SELECT, INSERT ON events TO app;
