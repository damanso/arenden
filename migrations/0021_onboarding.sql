-- FR-25, FR-4, B-27, Story 9.4: operatörssteget behöver kunna skapa en tenant.
-- Bara id och namn får skrivas; det normaliserade namnet är unikt även över
-- tenantgränsen. Låset serialiserar mottagningar före prövningen av människan.
GRANT INSERT (id, namn) ON tenants TO app;

CREATE UNIQUE INDEX tenants_namn_unik ON tenants (lower(btrim(namn)));

CREATE FUNCTION tenantmottagningens_las() RETURNS void LANGUAGE sql AS $$
  SELECT pg_advisory_xact_lock(940400)
$$;
REVOKE ALL ON FUNCTION tenantmottagningens_las() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenantmottagningens_las() TO app;
