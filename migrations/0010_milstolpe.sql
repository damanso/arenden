-- K-3: milstolpe. 28 ärenden bar en projektmilstolpe i Linear — fem namn
-- (M0..M4), samtliga i ETT projekt.
--
-- Varför en kolumn och inte en tabell: i arkivet har milstolpen inget eget liv.
-- Den har inget datum, ingen status, ingen ordning utöver namnet, och ingen
-- händelse i historiken rör den. En egen tabell hade infört en entitet som
-- ingen skapar, ingen ändrar och ingen stänger — schema utan innehåll. Blir
-- milstolpen någon gång ett objekt med datum och status flyttas kolumnen dit
-- med data i behåll; det omvända (tom tabell som ska fyllas i efterhand) är
-- dyrare. Estimat och cykel byggs inte alls: 0 av 312 bar dem.

ALTER TABLE issues ADD COLUMN milstolpe text;

CREATE INDEX issues_milstolpe_idx ON issues (tenant_id, milstolpe) WHERE milstolpe IS NOT NULL;
