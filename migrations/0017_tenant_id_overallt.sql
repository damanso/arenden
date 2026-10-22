-- FR-3, Story 7.4, arkitekturens beslut under Data Architecture:
-- tenant_id NOT NULL med index i varje tabell. Kodgranskningens «delvis»
-- gäller de två sista undantagen, tenantregistret och migrationsledgern.
-- tenants.tenant_id härleds av databasen ur radens eget id: en tenant hör
-- alltid till sig själv, och onboardingen (Story 9.4) behöver inte skriva det.
-- Ledgern skapas av migrationsverktyget, inte av en migration. En ny ledger
-- har redan kolumnen, så ledgerns satser tål att den finns. Befintliga rader
-- får Locollabs tenant; standarden tas sedan bort så att verktyget skriver
-- värdet på varje ny rad och en rad utan värdet avvisas.
-- Inga RLS-policyer skapas (Etapp 3). Ingen GRANT behövs: app har SELECT
-- på hela tenants och ingen rättighet på ledgern.

ALTER TABLE tenants
  ADD COLUMN tenant_id uuid NOT NULL GENERATED ALWAYS AS (id) STORED;

CREATE INDEX tenants_tenant_idx ON tenants (tenant_id);

ALTER TABLE schema_migrations
  ADD COLUMN IF NOT EXISTS tenant_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE schema_migrations ALTER COLUMN tenant_id DROP DEFAULT;

CREATE INDEX IF NOT EXISTS schema_migrations_tenant_idx ON schema_migrations (tenant_id);
