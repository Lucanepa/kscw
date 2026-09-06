-- Migration 353: deleting a hall clears up after itself.
--
-- `trg_protect_hall_delete` refused to delete any hall that still had a
-- hall_slot WITH A TEAM on it, telling the admin to "Remove slots first" — an
-- instruction with no UI behind it until the halls page shipped, and busywork
-- even now: the slots are being deleted either way, one at a time, by hand.
--
-- ⚠⚠ The veto was ALSO incomplete, which is the more interesting half. It only
-- fired on slots that had a team; a hall whose slots were all teamless deleted
-- cleanly TODAY and left three columns pointing at a row that no longer
-- exists, because they carry no foreign key at all:
--     events.hall, game_scheduling_slots.hall, slot_claims.hall
-- So the protection was strict where it did not need to be and absent where it
-- did. This replaces it with a cascade that is explicit about both halves.
--
-- ── What is DELETED (meaningless without the hall) ───────────────────
--   hall_slots           — a slot IS "this weekday, this time, in this hall"
--                          (cascades hall_slots_teams + training_slot_skips)
--   hall_closures        — a closure with no hall closes nothing
--   slot_claims          — a claim on a slot in a hall that is gone
--   game_scheduling_slots— a home-game offer in a hall that is gone
--
-- ── What is KEPT, with the pointer nulled ────────────────────────────
--   trainings, games     — real activities carrying RSVPs, rosters and
--                          results. `trainings.hall` and `games.hall` are
--                          already ON DELETE SET NULL, and trainings keep the
--                          free-text `hall_name` as a human fallback.
--   events               — same, but there is NO FK, so the NULL has to be
--                          written here or the column dangles.
--
-- ⚠⚠ Deleting the hall's slots does NOT delete its trainings:
-- `trainings_hall_slot_foreign` is ON DELETE SET NULL, so every generated
-- training survives with `hall_slot = NULL` and keeps its date, team and every
-- participation row. Nothing in this cascade can destroy an RSVP or a result —
-- that property is the whole reason the delete list stops where it does.
--
-- ⚠ The recurring TRAINING PLAN for every team in that hall does go, though,
-- and that is not recoverable from the app. The guardrail is moved up to the
-- UI, which now counts the rows and names them in the confirm dialog before
-- anything is sent — the DB should not refuse what an admin has explicitly
-- confirmed, but the admin has to be told what they are confirming.
--
-- Idempotent: CREATE OR REPLACE on the function, DROP-then-CREATE the trigger.

CREATE OR REPLACE FUNCTION public.trg_protect_hall_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Order matters: slot_claims reference hall_slots by id but carry no FK, so
  -- they have to go before the slots they point at, or they are orphaned by
  -- the very statement meant to clean them up.
  DELETE FROM slot_claims
   WHERE hall = OLD.id
      OR hall_slot IN (SELECT id FROM hall_slots WHERE hall = OLD.id);

  DELETE FROM game_scheduling_slots WHERE hall = OLD.id;
  DELETE FROM hall_closures         WHERE hall = OLD.id;
  DELETE FROM hall_slots            WHERE hall = OLD.id;

  -- No FK on this one (unlike trainings.hall / games.hall, which the FK sets
  -- to NULL for us), so without this the column keeps a dead hall id.
  UPDATE events SET hall = NULL WHERE hall = OLD.id;

  RETURN OLD;
END;
$$;

-- The trigger itself is unchanged and already bound to this function under the
-- name `trg_halls_protect_delete` — CREATE OR REPLACE above is the whole
-- change. Recreated defensively (same name, so no second trigger is possible)
-- so a fresh install built from SCHEMA.sql cannot end up without it.
DROP TRIGGER IF EXISTS trg_halls_protect_delete ON public.halls;
CREATE TRIGGER trg_halls_protect_delete
  BEFORE DELETE ON public.halls
  FOR EACH ROW EXECUTE FUNCTION public.trg_protect_hall_delete();
