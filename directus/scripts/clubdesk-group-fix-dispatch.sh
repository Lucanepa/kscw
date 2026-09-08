#!/usr/bin/env bash
# Host dispatcher for the in-app superadmin "Fix groups" button (cron, every
# minute). Claims a queued job from clubdesk_member_sync.grp_*, runs the two proven
# group scrapers over the SERVER-BUILT worklist, and writes back the per-row result
# the button polls. Third sibling of clubdesk-member-dispatch.sh (down) and
# clubdesk-member-up-dispatch.sh (up).
#
# Why a dispatcher at all: ClubDesk has no API and its CSV import treats `Gruppen`
# as a no-op, so an allocation can only be written by driving the real UI. Directus
# runs in a Docker container and cannot launch a browser, so the endpoint only sets
# a request flag — this claims it and does the work.
#
#   grp_worklist.add    → clubdesk-scrape-groups.mjs  ("Kontakt zu Gruppe hinzufügen")
#   grp_worklist.remove → clubdesk-remove-group.mjs   (detail-view chip ×)
#
# Both tools locate the contact by the Wiedisync uuid, never by name — see
# CLAUDE.md → ClubDesk contact matching in the UI.
#
# Install at /opt/clubdesk-sync/ and wire to root crontab, e.g.:
#   * * * * * CLUBDESK_ENV=prod CLUBDESK_GRPFIX_COMMIT=1 /opt/clubdesk-sync/clubdesk-group-fix-dispatch.sh >> /opt/clubdesk-sync/group-fix.log 2>&1
#   * * * * * CLUBDESK_ENV=dev  DB=directus_kscw_dev     /opt/clubdesk-sync/clubdesk-group-fix-dispatch.sh >> /opt/clubdesk-sync/group-fix-dev.log 2>&1
#
# ⚠ COMMIT WRITES TO THE CLUB'S LEGAL MEMBER REGISTER. Three independent gates:
#     1. the endpoint refuses mode=commit unless a preview of the same job succeeded;
#     2. CLUBDESK_GRPFIX_COMMIT=1 must be set on the cron (default = force preview);
#     3. CLUBDESK_ENV must be prod — there is NO dev ClubDesk instance (one shared
#        account), so any other env is forced to preview even with the flag set.
# ⚠ Runaway guard: the worklist is capped host-side too (CAP, default 120). The
#   endpoint caps it as well; this is the backstop for a hand-edited grp_worklist.
#   A normal run is 0–3 rows. The 2026-07-16 incident — 29 DU20 girls stripped out
#   of ClubDesk by a departure test keyed on the wrong column — is why every layer
#   here counts before it acts.
set -uo pipefail
DIR=/opt/clubdesk-sync
PG=kscw-postgres
PW_IMG=mcr.microsoft.com/playwright:v1.60.0-jammy
CAP="${CLUBDESK_GRPFIX_CAP:-120}"

# ── Single env selection (claim/write-back DB must never diverge from the TARGET) ──
# CLUBDESK_ENV is the ONE knob, with the SAME dev/prod mapping as its siblings, so a
# mis-wired cron cannot claim on dev while writing prod. Fail fast on a bad env, and
# on an explicit legacy DB= that disagrees.
DB_REQUESTED="${DB:-}"
CLUBDESK_ENV="${CLUBDESK_ENV:-prod}"
case "$CLUBDESK_ENV" in
  prod) DB=postgres ;;
  dev)  DB=directus_kscw_dev ;;
  *) echo "FATAL: bad CLUBDESK_ENV '$CLUBDESK_ENV' (expected dev|prod)" >&2; exit 1 ;;
esac
if [ -n "$DB_REQUESTED" ] && [ "$DB_REQUESTED" != "$DB" ]; then
  echo "FATAL: explicit DB=$DB_REQUESTED conflicts with CLUBDESK_ENV=$CLUBDESK_ENV (→ $DB)" >&2; exit 1
fi
export CLUBDESK_ENV

# Per-env claim lock; the ClubDesk scrape itself serialises on the shared .sync.lock.
exec 9>"$DIR/.group-fix-${DB}.lock"
flock -n 9 || exit 0

psqlc() { docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -tAc "$1"; }

# Live progress + log tail (migration 355). Best effort: an /opt/clubdesk-sync that
# clubdesk:deploy has not reached yet has no helper, and a group fix must never fail
# because it could not report on itself.
CDP_JOB=grp
if [ -r "$DIR/clubdesk-progress.sh" ]; then
  # shellcheck source=/dev/null
  . "$DIR/clubdesk-progress.sh"
else
  cdp() { :; }; cdp_reset() { :; }; cdp_fail() { :; }; cdp_stream() { cat; }; cdp_cleanup() { :; }
fi

# Write-through of the mirror the findings are computed from (see the script's own
# header). Same best-effort framing as the progress helper: a run must never fail
# because it could not refresh wiedisync's copy of the register.
if [ -r "$DIR/clubdesk-mirror-patch.sh" ]; then
  # shellcheck source=/dev/null
  . "$DIR/clubdesk-mirror-patch.sh"
else
  cd_mirror_patch() { :; }
fi

# Recover a stuck 'running' so it can't block the button forever. KEEP
# grp_requested_at: the claim below requires it IS NOT NULL, so nulling it here
# would silently drop a request that was queued while the run was wedged.
psqlc "UPDATE clubdesk_member_sync SET grp_state='failed', grp_message='Reset (stale run — will retry)' WHERE id=1 AND grp_state='running' AND grp_requested_at < now() - interval '30 minutes'" >/dev/null 2>&1 || true

# Atomically claim. CTE so the top-level statement is a SELECT (a bare
# UPDATE…RETURNING via psql -tAc also prints the "UPDATE 1" command tag).
claim=$(psqlc "WITH u AS (UPDATE clubdesk_member_sync SET grp_state='running' WHERE id=1 AND grp_requested_at IS NOT NULL AND grp_state <> 'running' RETURNING 1) SELECT count(*) FROM u" 2>/dev/null || echo 0)
[ "$claim" = "1" ] || exit 0

MODE=$(psqlc "SELECT COALESCE(grp_mode,'preview') FROM clubdesk_member_sync WHERE id=1")
echo "=== group-fix: requested (mode=$MODE, db=$DB) $(TZ=Europe/Zurich date +'%d.%m.%Y %H:%M:%S') ==="
cdp_reset
cdp 3 "Reading the worklist…"

fail() {
  cdp_fail "$1"
  psqlc "UPDATE clubdesk_member_sync SET grp_state='failed', grp_requested_at=NULL, grp_finished_at=now(), grp_message=\$m\$$1\$m\$ WHERE id=1"
  echo "=== group-fix: FAILED — $1 ==="
  exit 0
}

# ── Commit gating ───────────────────────────────────────────────────────────────
# (2) explicit flag, (3) hard env guard. Gate (1) — "a preview succeeded first" —
# lives in the endpoint, which is the only place that knows what the operator saw.
#
# ⚠ A downgrade is PERSISTED back to grp_mode, not just logged. The UI labels the
# result off grp_mode, so leaving it on 'commit' after forcing preview would show
# the operator "Commit result — 4 changes" for a run that wrote NOTHING, and the
# next sync-down would then "mysteriously" revert changes that were never made.
# A refused write must never be reportable as a completed one.
DOWNGRADED=
if [ "$MODE" = "commit" ]; then
  if [ "${CLUBDESK_GRPFIX_COMMIT:-0}" != "1" ]; then
    DOWNGRADED="commit refused: CLUBDESK_GRPFIX_COMMIT is not set on this cron — ran as preview, nothing was written"
    MODE=preview
  elif [ "$CLUBDESK_ENV" != "prod" ]; then
    DOWNGRADED="commit refused: env is $CLUBDESK_ENV, not prod (no dev ClubDesk instance) — ran as preview, nothing was written"
    MODE=preview
  fi
fi
if [ -n "$DOWNGRADED" ]; then
  echo "REFUSING commit — $DOWNGRADED" >&2
  psqlc "UPDATE clubdesk_member_sync SET grp_mode='preview' WHERE id=1" >/dev/null
fi

# ── Pull the server-built worklist ──────────────────────────────────────────────
# ⚠ The worklist carries member names + uuids — trap-clean the files, and null the
# column after the run so it never lingers on the singleton row.
WL_ADD="$DIR/group-fix-add.json"
WL_REM="$DIR/group-fix-remove.json"
cleanup() { rm -f "$WL_ADD" "$WL_REM"; cdp_cleanup; }
trap cleanup EXIT

psqlc "SELECT COALESCE(grp_worklist->>'add','[]') FROM clubdesk_member_sync WHERE id=1" > "$WL_ADD" || fail "could not read add worklist"
psqlc "SELECT COALESCE(grp_worklist->>'remove','[]') FROM clubdesk_member_sync WHERE id=1" > "$WL_REM" || fail "could not read remove worklist"

N_ADD=$(psqlc "SELECT COALESCE(jsonb_array_length(grp_worklist->'add'),0) FROM clubdesk_member_sync WHERE id=1" 2>/dev/null || echo 0)
N_REM=$(psqlc "SELECT COALESCE(jsonb_array_length(grp_worklist->'remove'),0) FROM clubdesk_member_sync WHERE id=1" 2>/dev/null || echo 0)
TOTAL=$(( N_ADD + N_REM ))
echo "Worklist: $N_ADD add, $N_REM remove (mode=$MODE)"

[ "$TOTAL" -eq 0 ] && fail "empty worklist"
# Backstop cap — the endpoint caps too; this catches a hand-edited grp_worklist.
[ "$TOTAL" -gt "$CAP" ] && fail "$TOTAL changes exceed CAP=$CAP — refusing to run"

# ── Run the scrapers ────────────────────────────────────────────────────────────
# Both under the shared blocking .sync.lock: ONE ClubDesk session per account, so a
# concurrent down/up/finance scrape makes us wait rather than collide. Each tool
# prints one JSON summary line on stdout; its progress log goes to stderr → our log.
# REMOVALS RUN FIRST: the stale-Funktion class is a swap (drop the wrong token, add
# the right one), and doing it in this order never leaves a member holding two
# contradictory allocations if the second half fails.
# ⚠ stdout stays the JSON summary alone (`tail -1` is the result). The tool's own
# log — including its per-contact `@@STEP` markers — is on stderr, which is piped
# through cdp_stream so the bar and the live log move with the CONTACTS rather than
# with the two coarse remove/add phases. CDP_BASE/CDP_SPAN hand the tool its slice
# of the run: removals run first and own 10-50%, additions 50-92%.
run_tool() { # run_tool <script> <worklist-file> <base> <span> → JSON summary on stdout
  flock "$DIR/.sync.lock" docker run --rm -w /work -v "$DIR":/work --env-file "$DIR/.env" \
    -e "CDP_BASE=$3" -e "CDP_SPAN=$4" "$PW_IMG" \
    node "$1" "$(basename "$2")" "$MODE" 2> >(cdp_stream >&2) | tail -1
}

RES_REM='null'
if [ "$N_REM" -gt 0 ]; then
  echo "--- remove ($N_REM) ---"
  cdp 10 "Removing $N_REM group allocation(s)…"
  RES_REM=$(run_tool clubdesk-remove-group.mjs "$WL_REM" 10 40)
  [ -z "$RES_REM" ] && RES_REM='null'
  echo "remove result: $RES_REM"
fi

RES_ADD='null'
if [ "$N_ADD" -gt 0 ]; then
  echo "--- add ($N_ADD) ---"
  cdp 50 "Adding $N_ADD group allocation(s)…"
  RES_ADD=$(run_tool clubdesk-scrape-groups.mjs "$WL_ADD" 50 42)
  [ -z "$RES_ADD" ] && RES_ADD='null'
  echo "add result: $RES_ADD"
fi

# ── Write back ──────────────────────────────────────────────────────────────────
# A tool that produced no parseable summary is a FAILURE, not an empty success: the
# button would otherwise report "done · 0 changes" for a run that crashed on login.
if [ "$RES_ADD" = "null" ] && [ "$RES_REM" = "null" ]; then
  cdp_fail "Scraper produced no result — see group-fix.log"
  psqlc "UPDATE clubdesk_member_sync SET grp_state='failed', grp_requested_at=NULL, grp_finished_at=now(), grp_message='Scraper produced no result — see group-fix.log', grp_worklist=NULL WHERE id=1"
  echo "=== group-fix: FAILED (no scraper output) ==="
  exit 0
fi

RESULT=$(printf '{"mode":"%s","add":%s,"remove":%s}' "$MODE" "$RES_ADD" "$RES_REM")
MSG="$MODE: $N_ADD add, $N_REM remove"
# Say so on the row the operator reads, not only in a log nobody opens.
[ -n "$DOWNGRADED" ] && MSG="$MSG — $DOWNGRADED"
cdp 100 "$MSG"
psqlc "UPDATE clubdesk_member_sync SET grp_state='done', grp_requested_at=NULL, grp_finished_at=now(), grp_message=\$m\$$MSG\$m\$, grp_result=\$r\$$RESULT\$r\$, grp_worklist=NULL WHERE id=1" \
  || fail "write-back failed"

# ── Keep our copy of the register in step ───────────────────────────────────────
# Only after a real commit, and only for the rows the tools reported as written.
# Without this the page recomputes its findings from a snapshot taken BEFORE the
# run and lists everything it just fixed — which is what made the button look
# broken and got it run three times over (08.09.2026).
if [ "$MODE" = "commit" ]; then
  cd_mirror_patch "$RESULT" | sed 's/^/  /'
fi
echo "=== group-fix: done ($MSG) $(TZ=Europe/Zurich date +'%d.%m.%Y %H:%M:%S') ==="
