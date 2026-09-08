#!/usr/bin/env bash
# Host dispatcher for the in-app superadmin "Sync down from ClubDesk" button (cron,
# every minute). Claims a queued request from clubdesk_member_sync, runs the member
# sync (clubdesk-sync.sh), and writes back the state the button polls. flock keeps a
# single dispatcher at a time. Twin of clubdesk-finance-dispatch.sh.
#
# Install on the VPS at /opt/clubdesk-sync/ alongside clubdesk-sync.sh, and wire to
# root crontab, e.g.:
#   * * * * * /opt/clubdesk-sync/clubdesk-member-dispatch.sh >> /opt/clubdesk-sync/member-dispatch.log 2>&1
#
# CLUBDESK_ENV (dev|prod) flows through to clubdesk-sync.sh → picks the target DB.
set -uo pipefail
DIR=/opt/clubdesk-sync
PG=kscw-postgres

# ── Single env selection (claim/write-back DB must never diverge from the sync
# TARGET) ────────────────────────────────────────────────────────────────────────
# CLUBDESK_ENV is the ONE knob: it derives BOTH the DB this dispatcher claims/writes
# back to AND (exported) the DB clubdesk-sync.sh loads, using the SAME dev/prod
# mapping as clubdesk-sync.sh. This makes it impossible for a mis-wired cron to claim
# on dev while syncing prod (or vice-versa). Fail fast on a bad env, and — for legacy
# crons that still set DB directly — fail fast if that explicit DB disagrees.
DB_REQUESTED="${DB:-}"   # capture any explicit override BEFORE we derive the real DB
CLUBDESK_ENV="${CLUBDESK_ENV:-prod}"
case "$CLUBDESK_ENV" in
  prod) DB=postgres ;;
  dev)  DB=directus_kscw_dev ;;
  *) echo "FATAL: bad CLUBDESK_ENV '$CLUBDESK_ENV' (expected dev|prod)" >&2; exit 1 ;;
esac
if [ -n "$DB_REQUESTED" ] && [ "$DB_REQUESTED" != "$DB" ]; then
  echo "FATAL: explicit DB=$DB_REQUESTED conflicts with CLUBDESK_ENV=$CLUBDESK_ENV (→ $DB)" >&2; exit 1
fi
export CLUBDESK_ENV   # clubdesk-sync.sh derives the SAME DB from this

# Per-env claim lock so the dev and prod dispatchers process their own requests
# independently (DB=postgres for prod, directus_kscw_dev for dev). The actual
# ClubDesk scrape is serialised separately on the shared .sync.lock below.
exec 9>"$DIR/.member-dispatch-${DB}.lock"
flock -n 9 || exit 0   # a previous dispatcher (same env) is still running

psqlc() { docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -tAc "$1"; }

# Live progress + log tail (migration 355). Best effort throughout: if the helper is
# missing — an older /opt/clubdesk-sync that clubdesk:deploy has not reached yet —
# the run must still work, so every call becomes a no-op rather than an error.
CDP_JOB=down
if [ -r "$DIR/clubdesk-progress.sh" ]; then
  # shellcheck source=/dev/null
  . "$DIR/clubdesk-progress.sh"
else
  cdp() { :; }; cdp_reset() { :; }; cdp_fail() { :; }; cdp_stream() { cat; }; cdp_cleanup() { :; }
fi

# Recover a stuck 'running' (a dispatch that died mid-sync) so it can't block forever.
# Set 'failed' but KEEP down_requested_at: a superadmin who queued a sync while the run
# was stuck still has down_requested_at set, and the claim below requires it IS NOT NULL
# — nulling it here would silently drop that queued request. Leaving it intact lets the
# next tick re-claim (state<>'running') and retry instead of dropping the work.
psqlc "UPDATE clubdesk_member_sync SET down_state='failed', down_message='Reset (stale run — will retry)' WHERE id=1 AND down_state='running' AND down_requested_at < now() - interval '15 minutes'" >/dev/null 2>&1 || true

# Atomically claim a queued request. CTE so the top-level statement is a SELECT —
# a bare UPDATE…RETURNING via psql -tAc also prints the "UPDATE 1" command tag.
claim=$(psqlc "WITH u AS (UPDATE clubdesk_member_sync SET down_state='running' WHERE id=1 AND down_requested_at IS NOT NULL AND down_state <> 'running' RETURNING 1) SELECT count(*) FROM u" 2>/dev/null || echo 0)
[ "$claim" = "1" ] || exit 0

echo "=== dispatch: member sync requested — running $(date -u +%FT%TZ) ==="
cdp_reset
cdp 2 "Waiting for the ClubDesk session lock…"
# Serialise the ClubDesk login against the up/finance/weekly scrapes (one session
# per account) — blocking, so a concurrent scrape makes us wait, not collide.
# ⚠ The run output is TEE'd, not just streamed. Until 2026-08-25 a failure wrote
# the fixed string 'Sync failed — see the member sync log' and threw the actual
# error away — and that log is a file on this host, which the superadmin who
# pressed the button cannot read. So the app could not tell them the difference
# between "ClubDesk is down, try later" and "our scraper is broken", which is the
# whole difference between waiting and calling for help. Real case: ClubDesk's
# app host went dark and two runs died on `page.goto: net::ERR_TIMED_OUT`, while
# the UI said only "see the log".
#
# ⚠ `set -uo pipefail` is set at the top, so `if … | tee` still tests the SYNC's
# exit status and not tee's. Do not remove pipefail without revisiting this.
RUNLOG="$(mktemp)"
trap 'rm -f "$RUNLOG"; cdp_cleanup' EXIT
# ⚠ cdp_stream sits BETWEEN the run and the tee, and passes every line through
# untouched — the host log and the ✗ parsing below still see exactly what they saw
# before. It only mirrors the lines into the DB and lifts the `@@STEP` markers the
# sync script and the scraper emit, so the bar moves with the SCRAPE rather than
# with the path step. Returns 0 always, so pipefail still reports the sync's status.
if flock "$DIR/.sync.lock" /opt/clubdesk-sync/clubdesk-sync.sh 2>&1 | cdp_stream | tee "$RUNLOG"; then
  # ⚠ down_last_success_at (migration 336) is stamped HERE and only here.
  # down_finished_at is written by both branches, so it can never answer
  # "when did a sync last succeed" — reading it as such painted a fresh
  # timestamp under the button after a FAILED run.
  cdp 100 "Synced from ClubDesk"
  psqlc "UPDATE clubdesk_member_sync SET down_state='done', down_requested_at=NULL, down_finished_at=now(), down_last_success_at=now(), down_message='Synced from ClubDesk' WHERE id=1"
  echo "=== dispatch: done ==="
else
  # The scraper marks its fatal line with '✗'. Take the FIRST one — later lines are
  # usually Playwright's call-log echo of the same failure. Fall back to the last
  # non-empty line, so an error that never printed a ✗ still says something.
  ERR="$(grep -m1 '✗' "$RUNLOG" 2>/dev/null | sed 's/^[[:space:]]*✗[[:space:]]*//')"
  [ -n "$ERR" ] || ERR="$(grep -v '^[[:space:]]*$' "$RUNLOG" 2>/dev/null | tail -1)"
  [ -n "$ERR" ] || ERR="Sync failed — see the member sync log"
  # ⚠ Capped and single-quote-escaped: this string is interpolated into SQL, and a
  # Playwright error can quote page content. 300 chars is well past the useful part
  # of every error the scraper has ever produced.
  ERR="$(printf '%s' "$ERR" | tr -d '\r' | cut -c1-300)"
  ERRQ="$(printf '%s' "$ERR" | sed "s/'/''/g")"
  # ⚠ The bar is left where it stopped and the phase says what it was doing —
  # "Failed: page.goto: net::ERR_TIMED_OUT" at 12% is a diagnosis, a bar reset to
  # zero is the blank the log tail exists to replace.
  cdp_fail "${ERR}"
  psqlc "UPDATE clubdesk_member_sync SET down_state='failed', down_requested_at=NULL, down_finished_at=now(), down_message='${ERRQ}' WHERE id=1"
  echo "=== dispatch: FAILED ==="
fi
