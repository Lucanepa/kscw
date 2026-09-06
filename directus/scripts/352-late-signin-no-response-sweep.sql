-- Migration 352: the sign-up deadline gets teeth.
--
-- Until now "late sign-in" only existed when a leader MANUALLY confirmed
-- someone past respond_by — ParticipationRosterModal pops IssueFineModal and
-- the leader clicks. A member who simply never answered triggered nothing at
-- all and stayed "no response" forever. The roster lied about who was coming,
-- and the one behaviour the fine was meant to price (ignoring the deadline)
-- was the one behaviour it could not see.
--
-- The daily participation cron (kscw-hooks, 06:30 UTC) now sweeps
-- non-responders once the deadline has passed: it writes a `declined`
-- participation and auto-issues the late_signin fine. BOTH halves are gated on
-- the team holding an ENABLED fine_rules row for `late_signin` — no rule, no
-- sweep, so nothing whatsoever changes for a team that has not opted in.
--
-- This migration carries the two things the sweep needs from the schema.
--
-- ── participations.auto_declined_deadline ────────────────────────────
-- "The system wrote this decline because the deadline passed." Same contract
-- `auto_declined_by` (absence-driven) has carried since migration 038: the
-- BEFORE UPDATE trigger strips the marker the moment a human changes `status`,
-- so a marker that is still set is proof the row is still system-owned.
-- Without it the roster shows a flat "Declined" and neither the coach nor the
-- member can tell a real "I can't come" from a missed deadline — which is
-- exactly the distinction the fine is charging for.
--
-- ⚠ Deliberately a NEW column rather than a reuse of `auto_declined_by`: that
-- one is an FK to `absences`, and a deadline decline has no absence behind it.
--
-- ── fines_auto_activity_unique ───────────────────────────────────────
-- One auto-issued fine per member×team×category×activity, enforced by the
-- database rather than by the cron remembering. The sweep is idempotent by
-- construction (the participation row it writes is what stops the member being
-- a non-responder on the next run), but "by construction" is not a guarantee,
-- and a double charge is money out of a real person's pocket. Partial on
-- `auto_issued` so it never constrains a leader issuing two manual fines for
-- the same game — that is a legitimate correction path.
--
-- ⚠⚠ Directus caches the schema at boot and a raw-SQL `directus_fields` insert
-- does NOT bust that cache. Restart after applying:
--   npm run db:migrate:dev && ssh hetzner "sudo docker restart directus-kscw-dev"
--
-- Schema-only + idempotent per the CLAUDE.md migration policy.

BEGIN;

-- ── (1) The marker column ────────────────────────────────────────────
ALTER TABLE participations
  ADD COLUMN IF NOT EXISTS auto_declined_deadline boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN participations.auto_declined_deadline IS
  'true = this declined row was written by the deadline sweep (kscw-hooks daily cron) because the member never responded before respond_by, not by a human. Cleared to false by trg_participations_clear_auto_marker the moment anyone changes `status`, so a surviving true is the definitive "still system-owned" signal — same contract as auto_declined_by (absences). Read by ParticipationRosterModal to label the row "No response — auto-declined" instead of a bare "Declined".';

-- ── (2) Teach the marker-clearing trigger about it ───────────────────
-- Identical semantics to the two markers already here: a status change that
-- does NOT itself carry a new marker value is a human edit, and a human edit
-- detaches the row from the system. Re-stated in full because CREATE OR
-- REPLACE FUNCTION has no additive form.
CREATE OR REPLACE FUNCTION trg_participations_clear_auto_marker()
RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.auto_declined_by IS NOT DISTINCT FROM OLD.auto_declined_by THEN
    NEW.auto_declined_by := NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.auto_declined_by_game IS NOT DISTINCT FROM OLD.auto_declined_by_game THEN
    NEW.auto_declined_by_game := NULL;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.auto_declined_deadline IS NOT DISTINCT FROM OLD.auto_declined_deadline THEN
    NEW.auto_declined_deadline := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- ── (3) One auto-fine per member per activity, enforced ──────────────
CREATE UNIQUE INDEX IF NOT EXISTS fines_auto_activity_unique
  ON fines (member, team, category, activity_type, activity_id)
  WHERE auto_issued = true;

COMMENT ON INDEX fines_auto_activity_unique IS
  'Backstop for the deadline sweep: a server-issued fine can exist at most once per member×team×category×activity. Partial on auto_issued so leader-issued corrections (waive + reissue, or two manual fines on one game) stay unconstrained.';

-- ── (4) Directus admin metadata ──────────────────────────────────────
INSERT INTO directus_fields (collection, field, special, interface, options, readonly, hidden, sort, width, note)
SELECT 'participations', 'auto_declined_deadline', 'cast-boolean', 'boolean', NULL::json, true, false, NULL::integer, 'half',
       'System-set: the member never answered before respond_by and the daily sweep declined them. Cleared automatically when anyone edits the status.'
WHERE NOT EXISTS (
  SELECT 1 FROM directus_fields WHERE collection = 'participations' AND field = 'auto_declined_deadline'
);

COMMIT;
