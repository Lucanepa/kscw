-- 356-clubdesk-empty-side-is-a-fill.sql
--
-- An empty wiedisync cell is a FILL, not a disagreement.
--
-- The five `overwrite` rules in import-clubdesk-csv.mjs (beitragskategorie,
-- sektion, register_status, eintritt, austritt) were written as
--
--     WHERE cd_x IS NOT NULL AND cd_x IS DISTINCT FROM ours
--
-- which is also true when OURS IS NULL. So a member whose column we never filled
-- staged as `overwrite` — rendered "Values disagree" — over a Wiedisync column
-- showing "—". Nothing disagreed: we simply had nothing.
--
-- It read as a fault in the sync at exactly the moment the sync had worked. Live
-- case (prod, 08.09.2026): the two contacts our CREATE push made on 03.09 came
-- back with ClubDesk's own Eintritt / Mitgliederstatus / Sektion — the register
-- answering the create, which is the point of step 4 — and the queue announced
-- six disagreements against six empty cells.
--
-- The rule is corrected at the source (the importer now stages `fill` when our
-- side is empty and `overwrite` only when BOTH hold a value); this relabels the
-- rows already queued, so the operator is not told "values disagree" over a blank
-- for one more cycle.
--
-- ⚠ Relabel only — no value, member, field or status changes, and accepting was
-- always the same write either way (the accept path dispatches on `rule` for
-- 'create' alone, and the refuse path keys off current_value being non-empty).
-- Bounded to `pending`: a decided row is history and must stay as it was decided.

UPDATE clubdesk_sync_proposals
   SET rule = 'fill'
 WHERE status = 'pending'
   AND rule = 'overwrite'
   AND NULLIF(BTRIM(COALESCE(current_value, '')), '') IS NULL;
