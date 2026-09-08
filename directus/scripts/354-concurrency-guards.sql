-- 354 — Guards for three concurrency races found by the 2026-09-08 backend audit.
--
-- SCHEMA ONLY (per the migration policy): two partial unique indexes that let
-- Postgres arbitrate a race the application cannot, plus one lease column. The
-- matching code changes ship after this, never before — a route that expects an
-- index this migration has not created yet 500s on deploy.
--
-- Verified against prod before writing: finance_expenses.file is uuid,
-- trainings.hall_slot is integer, trainings.date is date, and BOTH targets have
-- ZERO existing duplicates, so the indexes create without a dedupe pass. Re-check
-- with the two SELECTs below if this is ever applied to a diverged database.
--
--   select file from finance_expenses where file is not null
--     group by file having count(*) > 1;
--   select hall_slot, date from trainings where hall_slot is not null
--     group by hall_slot, date having count(*) > 1;

-- ── 1. One reimbursement claim per receipt file ───────────────────────────────
-- expense-upload.js reads "does a claim already exist for this file?" and then
-- inserts, with no transaction between the two. A double-submitted upload form
-- creates two identical pending claims for one receipt — same amount, same payout
-- IBAN — sitting in the finance queue to be paid twice. The file is the natural
-- identity: one receipt backs exactly one claim.
-- Partial, because a claim may legitimately carry no file.
CREATE UNIQUE INDEX IF NOT EXISTS finance_expenses_file_uq
  ON finance_expenses (file)
  WHERE file IS NOT NULL;

-- ── 2. One training per hall slot per date ────────────────────────────────────
-- slot-cascade.js generates concrete `trainings` rows from recurring `hall_slots`.
-- Two cascades overlapping (a slot edit landing while the nightly top-up runs)
-- both find no row for the date and both insert, so the session shows twice in the
-- team calendar and the Hallenplan and collects two independent RSVP sets.
-- Partial, because a one-off training has no hall_slot and several may share a date.
CREATE UNIQUE INDEX IF NOT EXISTS trainings_hall_slot_date_uq
  ON trainings (hall_slot, date)
  WHERE hall_slot IS NOT NULL;

-- ── 3. A lease timestamp for the Volleymanager nomination push ────────────────
-- The push spawns a detached worker that files an Einsatzliste into the REAL Swiss
-- Volley production system — there is no VM staging. Two workers on one fixture
-- file it twice.
--
-- ⚠⚠ This column is the whole reason the guard needs a migration. An earlier
-- attempt claimed the game by setting vm_nomination_status='pending' with no
-- expiry, releasing only via an in-process exit listener. Every `ext:deploy`
-- restarts the container, so a lost worker stranded the row at 'pending' for ever
-- — after which the */5 cron skipped it AND the coach's manual "Push now" (which
-- only renders for status 'failed') could not reach it either, so the Einsatzliste
-- could never be filed at all. That was strictly worse than the duplicate it
-- prevented, and it was reverted. A claim is only safe if it can EXPIRE, and
-- vm_nomination_pushed_at means "last successful push", so it cannot serve.
--
-- Deliberately NOT registered in directus_fields: it is an internal lease, never
-- read through the items API or shown in the dashboard, so it needs no field row
-- and no schema-cache restart.
ALTER TABLE games ADD COLUMN IF NOT EXISTS vm_nomination_claimed_at timestamptz;

COMMENT ON COLUMN games.vm_nomination_claimed_at IS
  'When the current nomination-push worker claimed this game. Lets a stale claim be reclaimed after a container restart or a lost worker; NULL when unclaimed.';

-- Lets the cron find reclaimable rows without scanning: the claim predicate is
-- "not pending, OR pending but claimed longer ago than the lease".
CREATE INDEX IF NOT EXISTS games_vm_nomination_claim_idx
  ON games (vm_nomination_status, vm_nomination_claimed_at)
  WHERE vm_nomination_status IS NOT NULL;
