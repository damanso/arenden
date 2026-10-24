-- FR-16 delkrav 5, B-07 (Story 5.5): huvudåtagandet får inte sättas genomfört medan
-- ett nödvändigt delresultat saknas. Vilka delresultat som är nödvändiga är ett
-- beslut, inte en räkning av barnärenden: Davids svar 2026-10-16 kl. 13.21 säger att
-- ett delresultat märks som nödvändigt med en loggad handling när delärendet skapas,
-- aldrig gissat ur titlar, och att märkningen bara tas bort med ett skäl i loggen.
--
-- En rad per märkt par av huvudärende och delärende. Märkningen hör till paret, inte
-- till delärendet: flyttas delärendet står märkningen kvar på det huvudåtagande den
-- gjordes för, så en flytt släpper aldrig ett huvudåtagande fritt i tysthet.
-- Borttagningen sätter borttagen i stället för att radera, så historiken står kvar,
-- och paret kan märkas på nytt (det unika indexet gäller bara aktiva rader).
--
-- Tabellen skapas tom. Inget härleds ur hierarkin: märkningen görs bara genom
-- actionen marka_nodvandigt_delresultat, med aktören ur nyckeln.

CREATE TABLE nodvandiga_delresultat (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  huvud_issue_id  uuid NOT NULL REFERENCES issues(id),
  del_issue_id    uuid NOT NULL REFERENCES issues(id),
  markt_av_typ    text NOT NULL CHECK (markt_av_typ IN ('manniska','agent','system')),
  markt_av_namn   text NOT NULL,
  markt           timestamptz NOT NULL DEFAULT now(),
  borttagen       timestamptz,
  -- Ett ärende kan inte vara sitt eget delresultat.
  CONSTRAINT nodvandiga_delresultat_inte_sig_sjalv CHECK (huvud_issue_id <> del_issue_id)
);

-- Högst en aktiv märkning per par. Indexet är det som ON CONFLICT i märkningen pekar ut.
CREATE UNIQUE INDEX nodvandiga_delresultat_aktiv
  ON nodvandiga_delresultat (tenant_id, huvud_issue_id, del_issue_id) WHERE borttagen IS NULL;
CREATE INDEX nodvandiga_delresultat_del_idx ON nodvandiga_delresultat (tenant_id, del_issue_id);

-- Minsta möjliga rättigheter: märkningen läses och förs in, och borttagningen sätter
-- bara borttagen. DELETE och tabellbred UPDATE ges aldrig.
GRANT SELECT, INSERT ON nodvandiga_delresultat TO app;
GRANT UPDATE (borttagen) ON nodvandiga_delresultat TO app;
