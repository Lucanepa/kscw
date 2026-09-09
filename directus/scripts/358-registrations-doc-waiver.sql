-- Migration 358: let an approver waive a required basketball document, on the
-- record, per registration.
--
-- The document gate is deliberately absolute: bbRequiredDocs() says what Swiss
-- Basketball's procedure demands and three enforcement points refuse anything
-- less (create route, doc-status, approval hook). That is right for the normal
-- case and wrong for the exception — Swiss Basketball does sometimes issue a
-- licence without a document the list demands, and until now the club's only
-- ways out were to upload a fake file or to edit the row in Data Studio, both of
-- which leave the dossier lying about what it holds.
--
-- WHY A LIST OF FIELD NAMES AND NOT A BOOLEAN. "Documents waived: yes" waives
-- whatever is missing *now* and, silently, whatever goes missing later — the
-- 2026-07 upload faults deleted documents from rows that had them, and a blanket
-- flag would have let those rows sail through the gate afterwards. Naming the
-- fields keeps the waiver to the documents somebody actually looked at; a
-- different document going missing still blocks approval.
--
-- The waiver is subtractive only: it removes a document from the required set
-- for this one row. It cannot add a requirement, so no pending registration can
-- become un-approvable because of it, and a row with no waiver behaves exactly
-- as it does today.
--
-- Scope: the required set is one concept, so the waiver applies wherever that
-- set is read — the approval gate, the public "Dokumente nachreichen" status,
-- the prefilled-form route and the docs-request email. Waiving a document and
-- then still mailing the family to ask for it would be the bug this is meant to
-- prevent.

BEGIN;

-- Comma-separated registration column names (e.g. 'bb_doc_freibrief'), matching
-- the keys bbRequiredDocs() returns. Text rather than jsonb: the reader is
-- bb-docs.js, which already parses a comma list for nationality codes, and the
-- set is at most six short identifiers.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS bb_docs_waived          text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS bb_docs_waived_reason   text;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS bb_docs_waived_by_name  varchar(255);
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS bb_docs_waived_by_email varchar(255);
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS bb_docs_waived_at       timestamptz;

-- A waiver without a stated reason is an unexplained gap in the dossier a year
-- from now, when whoever waived it has left the board. The CHECK makes the
-- reason structurally impossible to omit; the hook rejects it earlier with a
-- readable 400 so nobody meets this constraint in the UI.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'registrations_bb_docs_waived_reason_check'
  ) THEN
    ALTER TABLE registrations
      ADD CONSTRAINT registrations_bb_docs_waived_reason_check
      CHECK (
        bb_docs_waived IS NULL
        OR btrim(bb_docs_waived) = ''
        OR (bb_docs_waived_reason IS NOT NULL AND btrim(bb_docs_waived_reason) <> '')
      );
  END IF;
END $$;

COMMENT ON COLUMN registrations.bb_docs_waived IS
  'Comma-separated required-document columns an approver waived for THIS registration (e.g. ''bb_doc_freibrief''). Subtracted from bbRequiredDocs() everywhere the required set is read. NULL/empty = no waiver.';
COMMENT ON COLUMN registrations.bb_docs_waived_reason IS
  'Why the documents above were waived. Mandatory whenever bb_docs_waived is non-empty (CHECK + kscw-hooks).';

-- ── Directus admin metadata ────────────────────────────────────────────
-- Stamps are written by the kscw-hooks filter, never by hand: a self-declared
-- "waived by" is not evidence. Readonly in Data Studio says so.
INSERT INTO directus_fields (collection, field, interface, width, note)
SELECT 'registrations', 'bb_docs_waived', 'input', 'half',
  'Waived required documents (comma-separated column names) — subtracted from the required set for this row'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'registrations' AND field = 'bb_docs_waived');

INSERT INTO directus_fields (collection, field, interface, width, note)
SELECT 'registrations', 'bb_docs_waived_reason', 'input-multiline', 'full',
  'Why those documents were waived — required whenever a waiver is set'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'registrations' AND field = 'bb_docs_waived_reason');

INSERT INTO directus_fields (collection, field, interface, width, readonly, note)
SELECT 'registrations', 'bb_docs_waived_by_name', 'input', 'half', true,
  'Stamped by kscw-hooks — who waived'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'registrations' AND field = 'bb_docs_waived_by_name');

INSERT INTO directus_fields (collection, field, interface, width, readonly, note)
SELECT 'registrations', 'bb_docs_waived_by_email', 'input', 'half', true,
  'Stamped by kscw-hooks — who waived'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'registrations' AND field = 'bb_docs_waived_by_email');

INSERT INTO directus_fields (collection, field, interface, display, width, readonly, note)
SELECT 'registrations', 'bb_docs_waived_at', 'datetime', 'datetime', 'half', true,
  'Stamped by kscw-hooks — when the waiver was set'
WHERE NOT EXISTS (SELECT 1 FROM directus_fields WHERE collection = 'registrations' AND field = 'bb_docs_waived_at');

COMMIT;
