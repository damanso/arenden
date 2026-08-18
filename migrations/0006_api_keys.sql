-- KRAV-10: alla /api-anrop kräver `Authorization: Bearer <nyckel>`.
--
-- Endast hashen lagras (sha256 hex). Aktören i events tas ALLTID ur nyckeln —
-- aldrig ur request-body — så anonym eller självdeklarerad skrivning är omöjlig.

CREATE TABLE api_keys (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  nyckelhash text NOT NULL,
  aktor_typ  text NOT NULL CHECK (aktor_typ IN ('manniska', 'agent', 'system')),
  aktor_namn text NOT NULL,
  aktiv      boolean NOT NULL DEFAULT true,
  skapad     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_hash_unik UNIQUE (nyckelhash)
);

CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

GRANT SELECT, INSERT ON api_keys TO app;
