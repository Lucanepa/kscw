-- 355-clubdesk-job-progress.sql
--
-- Live progress + a terminal log for the three ClubDesk jobs (down / up / group fix).
--
-- Until now every one of them reported exactly two things to the app: a state
-- ('queued'|'running'|'done'|'failed') and, at the very end, a message. A sync-down
-- takes three to five minutes, so the operator watched an indeterminate bar that
-- was, honestly, a guess: the frontend filled it by STEP INDEX (step 1 of 5 = 20%,
-- plus half a slice while running), which says where the runner is in the path and
-- nothing at all about where the job is inside itself. A ClubDesk login that hangs
-- and a scrape that is 90% done looked identical.
--
-- Three columns per job, written by the host dispatchers as they go:
--   *_phase     what it is doing right now, in one short sentence
--   *_progress  0-100, the job's own progress (never the path's)
--   *_log       the last ~25 output lines, so the operator can read what the
--               scraper actually said instead of asking someone to SSH in
--
-- ⚠ The log is a TAIL, not an archive. The full run output stays on the host
-- (member-dispatch.log / up-run.log / group-fix.log); this column exists so the
-- person who pressed the button can see the last few lines without shell access,
-- and is truncated by the writer so a runaway scraper cannot grow the row without
-- bound. Never treat it as the record of a run.
--
-- ⚠ Progress is advisory. It is written by shell on a best-effort basis (`|| true`
-- in the dispatchers), so a missed write must never break a run — the state columns
-- remain the only thing correctness depends on.

ALTER TABLE clubdesk_member_sync
  ADD COLUMN IF NOT EXISTS down_phase    varchar(120),
  ADD COLUMN IF NOT EXISTS down_progress smallint,
  ADD COLUMN IF NOT EXISTS down_log      text,
  ADD COLUMN IF NOT EXISTS up_phase      varchar(120),
  ADD COLUMN IF NOT EXISTS up_progress   smallint,
  ADD COLUMN IF NOT EXISTS up_log        text,
  ADD COLUMN IF NOT EXISTS grp_phase     varchar(120),
  ADD COLUMN IF NOT EXISTS grp_progress  smallint,
  ADD COLUMN IF NOT EXISTS grp_log       text;

COMMENT ON COLUMN clubdesk_member_sync.down_phase    IS 'What the sync-down is doing right now (one short sentence, written by clubdesk-member-dispatch.sh).';
COMMENT ON COLUMN clubdesk_member_sync.down_progress IS '0-100 progress of the sync-down itself. Advisory: best-effort writes, never a correctness input.';
COMMENT ON COLUMN clubdesk_member_sync.down_log      IS 'Tail (~25 lines) of the sync-down run output. The full log lives on the host.';
COMMENT ON COLUMN clubdesk_member_sync.up_phase      IS 'What the sync-up is doing right now (written by clubdesk-member-up-dispatch.sh).';
COMMENT ON COLUMN clubdesk_member_sync.up_progress   IS '0-100 progress of the sync-up itself. Advisory.';
COMMENT ON COLUMN clubdesk_member_sync.up_log        IS 'Tail (~25 lines) of the sync-up run output.';
COMMENT ON COLUMN clubdesk_member_sync.grp_phase     IS 'What the group fix is doing right now (written by clubdesk-group-fix-dispatch.sh).';
COMMENT ON COLUMN clubdesk_member_sync.grp_progress  IS '0-100 progress of the group fix itself. Advisory.';
COMMENT ON COLUMN clubdesk_member_sync.grp_log       IS 'Tail (~25 lines) of the group-fix run output.';
