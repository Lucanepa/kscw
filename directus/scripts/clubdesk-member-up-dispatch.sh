#!/usr/bin/env bash
# Host dispatcher for the superadmin "Sync up to ClubDesk" action (cron, every
# minute). Claims a queued up-request from clubdesk_member_sync, writes the stashed
# CSV(s) (transcoded to CP1252 for ClubDesk), runs the import scraper (dry-run preview
# first, then commit only if enabled) under the shared ClubDesk-session lock, clears
# clubdesk_push_pending for the pushed members, and writes back up_state + up_result.
# Twin of the down dispatcher.
#
# Since migration 173 the push is TWO sets: up_csv (UPDATE set — linked members,
# [Id]-keyed name-less contact rows since 2026-07-08) and up_csv_create (CREATE
# set — new contacts, named, + Beitragskategorie + Eintritt). Either may be empty.
# They are separate CSVs so the category column can never reach a ClubDesk-owned
# category on an UPDATE import (spike 2026-07-08: empty cells are no-ops, absent
# columns untouched — the split stays as the structural guarantee). Commit order
# is CREATE first, and the creates
# get clubdesk_pushed_at stamped IMMEDIATELY after their commit: if the update-set
# commit then fails, the created contacts are already marked and can't be offered
# for a second (duplicating) push. Pre-173 DBs (no up_csv_create column) degrade
# to the single update-set flow.
#
# Install at /opt/clubdesk-sync/ and wire to root crontab, e.g.:
#   * * * * * CLUBDESK_ENV=prod CLUBDESK_UP_COMMIT=1 /opt/clubdesk-sync/clubdesk-member-up-dispatch.sh >> /opt/clubdesk-sync/up-dispatch.log 2>&1
#
# CLUBDESK_ENV (dev|prod) is the ONE knob — it derives the target DB with the SAME
# mapping as the down dispatcher / clubdesk-sync.sh, so a mis-wired cron can't claim on
# one env while pushing another. There is NO dev ClubDesk instance (single shared
# account), so a WRITE (commit) is only ever performed when CLUBDESK_ENV=prod AND
# CLUBDESK_UP_COMMIT=1; any other env is forced to dry-run regardless of the commit flag.
#
# ⚠ up_csv/up_csv_create carry member PII (address/birthdate) — the files are
#   trap-cleaned and both columns are nulled in the DB after the run; never let
#   either linger.
# ⚠ Commit WRITES to the club's legal member record. It is gated behind an explicit
#   CLUBDESK_UP_COMMIT=1 (default = dry-run only) AND a successful dry-run preview, so
#   a mis-wired cron can never silently write to ClubDesk. Commit is only ever reached
#   after a superadmin approved the set in the modal (the endpoint stashed the CSV).
set -uo pipefail
DIR=/opt/clubdesk-sync
PG=kscw-postgres
PW_IMG=mcr.microsoft.com/playwright:v1.60.0-jammy

# ── Single env selection (claim/write-back DB must never diverge from the push
# TARGET) ────────────────────────────────────────────────────────────────────────
# CLUBDESK_ENV is the ONE knob: it derives the DB this dispatcher claims/writes back to
# using the SAME dev/prod mapping as clubdesk-sync.sh + the down dispatcher. Fail fast
# on a bad env, and — for legacy crons that still set DB directly — fail fast if that
# explicit DB disagrees.
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
export CLUBDESK_ENV

# Per-env claim lock (dev vs prod process their own requests independently); the
# ClubDesk scrape itself is serialised on the shared .sync.lock further down.
exec 9>"$DIR/.up-dispatch-${DB}.lock"
flock -n 9 || exit 0   # a previous up-dispatcher (same env) is still running

psqlc() { docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -tAc "$1"; }

# Live progress + log tail (migration 355). Best effort: a /opt/clubdesk-sync that
# clubdesk:deploy has not reached yet has no helper, and a push must never fail
# because it could not report on itself.
CDP_JOB=up
if [ -r "$DIR/clubdesk-progress.sh" ]; then
  # shellcheck source=/dev/null
  . "$DIR/clubdesk-progress.sh"
else
  cdp() { :; }; cdp_reset() { :; }; cdp_fail() { :; }; cdp_stream() { cat; }; cdp_cleanup() { :; }
fi

# Pre-173 DBs lack the create-set columns — detect once and degrade gracefully
# (single update-set flow, and never reference the missing columns in SQL).
HAS_CREATE=$(psqlc "SELECT 1 FROM information_schema.columns WHERE table_name='clubdesk_member_sync' AND column_name='up_csv_create'" 2>/dev/null || true)
if [ "$HAS_CREATE" = "1" ]; then CLEAR_COLS="up_csv=NULL, up_csv_create=NULL"; else CLEAR_COLS="up_csv=NULL"; fi

# Recover a stuck 'running' (>15 min).
psqlc "UPDATE clubdesk_member_sync SET up_state='idle', up_requested_at=NULL, up_message='Reset (stale run)' WHERE id=1 AND up_state='running' AND up_requested_at < now() - interval '15 minutes'" >/dev/null 2>&1 || true

# Atomically claim a queued up-request (CTE so the top-level statement is a SELECT).
claim=$(psqlc "WITH u AS (UPDATE clubdesk_member_sync SET up_state='running' WHERE id=1 AND up_requested_at IS NOT NULL AND up_state <> 'running' RETURNING 1) SELECT count(*) FROM u" 2>/dev/null || echo 0)
[ "$claim" = "1" ] || exit 0

echo "=== up-dispatch: sync-up requested — running $(date -u +%FT%TZ) (db=$DB) ==="
cdp_reset
cdp 4 "Reading the push payload…"
CSVUTF_U="$DIR/up-import-update.utf8.csv"; CSV_U="$DIR/up-import-update.csv"
CSVUTF_C="$DIR/up-import-create.utf8.csv"; CSV_C="$DIR/up-import-create.csv"
cleanup() { rm -f "$CSVUTF_U" "$CSV_U" "$CSVUTF_C" "$CSV_C"; cdp_cleanup; }   # member PII — never linger
trap cleanup EXIT

# 1. Pull the stashed CSVs → files (UTF-8 from psql), transcode to CP1252 for ClubDesk.
#    COALESCE(…,'') so a NULL column yields an empty file (= set not present), and
#    psql's -tA blank line for '' is trimmed by the -s size test either way.
docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -tAc "SELECT COALESCE(up_csv,'') FROM clubdesk_member_sync WHERE id=1" | grep -v '^$' > "$CSVUTF_U" || true
if [ "$HAS_CREATE" = "1" ]; then
  docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -tAc "SELECT COALESCE(up_csv_create,'') FROM clubdesk_member_sync WHERE id=1" | grep -v '^$' > "$CSVUTF_C" || true
else
  : > "$CSVUTF_C"
fi
if [ ! -s "$CSVUTF_U" ] && [ ! -s "$CSVUTF_C" ]; then
  psqlc "UPDATE clubdesk_member_sync SET up_state='failed', up_requested_at=NULL, up_finished_at=now(), up_message='No CSV payload', ${CLEAR_COLS} WHERE id=1"
  echo "=== up-dispatch: FAILED (no CSV) ==="; exit 0
fi
[ -s "$CSVUTF_U" ] && { iconv -f UTF-8 -t WINDOWS-1252//TRANSLIT "$CSVUTF_U" > "$CSV_U" 2>/dev/null || cp "$CSVUTF_U" "$CSV_U"; }
[ -s "$CSVUTF_C" ] && { iconv -f UTF-8 -t WINDOWS-1252//TRANSLIT "$CSVUTF_C" > "$CSV_C" 2>/dev/null || cp "$CSVUTF_C" "$CSV_C"; }

# 2. Push to ClubDesk. Two-phase for safety (all scrapes run under the shared
#    ClubDesk-session lock — one session per account — against the down/weekly/finance
#    scrapes). Capture the JSON result (last stdout line); scraper logs → up-run.log.
#  (a) ALWAYS dry-run 'preview' EVERY present set first: ClubDesk uploads + maps the
#      CSV and reports the pre-commit summary, then backs out WITHOUT writing. Proves
#      both CSVs map cleanly before we ever touch the legal register.
#  (b) COMMIT (write) only if ALL previews succeeded AND commit is explicitly enabled
#      via CLUBDESK_UP_COMMIT=1. Default = dry-run only.
COMMIT_ENABLED="${CLUBDESK_UP_COMMIT:-0}"
#  (c) HARD ENV GUARD: ClubDesk is a single shared (prod) account — there is no dev
#      ClubDesk instance. A commit from the dev cron would write scrubbed test data into
#      the club's legal member register, so a WRITE is only ever allowed when
#      CLUBDESK_ENV=prod. On any other env we force dry-run (never commit) even if the
#      operator set CLUBDESK_UP_COMMIT=1.
if [ "$COMMIT_ENABLED" = "1" ] && [ "$CLUBDESK_ENV" != "prod" ]; then
  echo "REFUSING commit: CLUBDESK_ENV=$CLUBDESK_ENV (not prod) — forcing dry-run (no dev ClubDesk instance)" >&2
  COMMIT_ENABLED=0
fi

scrape() { # scrape <csv-file> <preview|commit> → JSON line on stdout
  # ⚠ stdout stays JSON-ONLY — `| tail -1` downstream is the result, and a progress
  # line printed there would be parsed as one. The scraper's human output is on
  # stderr, so that is what gets mirrored into the live log (and, as before,
  # appended to up-run.log). The phase and the bar are owned by this dispatcher,
  # which is the only thing that knows which of the four scrapes is running.
  flock "$DIR/.sync.lock" docker run --rm -w /work -v "$DIR":/work --env-file "$DIR/.env" "$PW_IMG" \
    node /work/clubdesk-scrape-import.mjs "/work/$(basename "$1")" "$2" \
    2> >(cdp_stream >> "$DIR/up-run.log") | tail -1
}
scrape_ok() { # preview/commit result sanity: reached a numeric summary, no error
  printf '%s' "$1" | grep -q '"total":[0-9]' && ! printf '%s' "$1" | grep -q '"error"'
}
num_field() { # num_field <json> <field> → integer (0 when null/absent)
  local v; v=$(printf '%s' "$1" | grep -o "\"$2\":[0-9]*" | head -1 | grep -o '[0-9]*$')
  echo "${v:-0}"
}
# Merged result for up_result: sums keep the modal's neu/veraendert display working
# unchanged; the per-set raw results ride along under "sets" for debugging.
merge_results() { # merge_results <committed:true|false> <json-update|''> <json-create|''>
  local committed=$1 ju=${2:-} jc=${3:-} t=0 n=0 v=0
  for j in "$ju" "$jc"; do
    [ -n "$j" ] || continue
    t=$((t + $(num_field "$j" total))); n=$((n + $(num_field "$j" neu))); v=$((v + $(num_field "$j" veraendert)))
  done
  printf '{"total":%s,"neu":%s,"veraendert":%s,"committed":%s,"sets":{"update":%s,"create":%s}}' \
    "$t" "$n" "$v" "$committed" "${ju:-null}" "${jc:-null}"
}
fail_run() { # fail_run <message> <result-json|''>
  cdp_fail "$1"
  local MSG_ESC=${1//\'/\'\'} RESSQL='NULL'
  if [ -n "${2:-}" ]; then local RES_ESC=${2//\'/\'\'}; RESSQL="'${RES_ESC}'::jsonb"; fi
  psqlc "UPDATE clubdesk_member_sync SET up_state='failed', up_requested_at=NULL, up_finished_at=now(), up_message='${MSG_ESC}', up_result=${RESSQL}, ${CLEAR_COLS} WHERE id=1"
}

PREVIEW_U=''; PREVIEW_C=''
if [ -s "$CSVUTF_U" ]; then
  cdp 18 "Dry-run of the changed members…"
  PREVIEW_U=$(scrape "$CSV_U" preview)
  echo "preview (update set): $PREVIEW_U"
  if ! scrape_ok "$PREVIEW_U"; then
    # Most likely cause since the [Id]-keyed switch (2026-07-08): a contact was
    # deleted in ClubDesk AFTER the last sync-down — its snapshot row still
    # passes /up's stale-link guard, and the unknown [Id] hard-aborts the whole
    # import wizard (no summary). Sync-down refreshes the snapshot, the guard
    # then skips that member, and the push goes through.
    fail_run 'Dry-run preview failed (update set) — if a contact was deleted in ClubDesk since the last sync-down, run "Sync down" and retry. Details: up-run.log' "$PREVIEW_U"
    echo "=== up-dispatch: FAILED (preview, update set) ==="; exit 0
  fi
  # ── Duplicate guard (2026-07-07; fail-closed rewrite 2026-07-08; unveränderte-
  #    aware 2026-07-15) ─────────────────────────────────────────────────────────
  # The UPDATE set is, by definition, linked members whose ClubDesk contacts
  # already exist. Since 2026-07-08 update rows are keyed on ClubDesk's own [Id]
  # (name-less CSV): a known [Id] upserts, an unknown [Id] hard-aborts the whole
  # import before the summary (spike-proven), so a "Neue" row is structurally
  # impossible unless the [Id] column regressed out of the CSV — committing then
  # would DUPLICATE contacts with EMPTY names.
  # Invariant enforced FAIL-CLOSED: neu == 0 AND neu+veraendert+unveraendert == total > 0.
  # Rows byte-identical to ClubDesk preview as "Unveränderte" (common right after a
  # sync-down aligns members), so the old veraendert==total check FALSE-refused a
  # safe push (2026-07-15: total=6 ver=3 unv=3, neu=0). The reconciliation sum keeps
  # the anti-duplication guarantee STRONGER than before: if ClubDesk omits/renames
  # ANY summary line (Neue absent when 0; Veränderte/Geänderte/Unveränderte wording
  # drift), the parsed counts no longer add up to total → refuse, never commit blind.
  # Ancestry: this is the guard whose absence created 19 mangled "?" duplicate
  # contacts on 2026-07-07 (name-matched era).
  NEU_U=$(num_field "$PREVIEW_U" neu); VER_U=$(num_field "$PREVIEW_U" veraendert); UNV_U=$(num_field "$PREVIEW_U" unveraendert); TOT_U=$(num_field "$PREVIEW_U" total)
  if [ "$TOT_U" -le 0 ] || [ "$NEU_U" -gt 0 ] || [ "$((NEU_U + VER_U + UNV_U))" -ne "$TOT_U" ]; then
    fail_run "Update-set push REFUSED: need neu=0 and neu+veraendert+unveraendert==total (total=${TOT_U}, veraendert=${VER_U}, unveraendert=${UNV_U}, neu=${NEU_U}). neu>0 means rows would be created (missing [Id] column?); a sum mismatch means the summary was unparseable or a label drifted — refusing to commit blind. See up-run.log." "$PREVIEW_U"
    echo "=== up-dispatch: FAILED (update-set reconcile: neu=${NEU_U} ver=${VER_U} unv=${UNV_U} tot=${TOT_U}) ==="; exit 0
  fi
fi
if [ -s "$CSVUTF_C" ]; then
  cdp 38 "Dry-run of the new contacts…"
  PREVIEW_C=$(scrape "$CSV_C" preview)
  echo "preview (create set): $PREVIEW_C"
  if ! scrape_ok "$PREVIEW_C"; then
    fail_run 'Dry-run preview failed (create set) — see up-run.log' "$PREVIEW_C"
    echo "=== up-dispatch: FAILED (preview, create set) ==="; exit 0
  fi
fi

if [ "$COMMIT_ENABLED" != "1" ]; then
  if [ "$CLUBDESK_ENV" != "prod" ]; then
    DRY_MSG="Dry-run OK — commit refused on CLUBDESK_ENV=${CLUBDESK_ENV} (no dev ClubDesk instance; only prod may write)"
  else
    DRY_MSG='Dry-run OK — commit disabled (set CLUBDESK_UP_COMMIT=1 to write)'
  fi
  DRY_MSG_ESC=${DRY_MSG//\'/\'\'}
  RES=$(merge_results false "$PREVIEW_U" "$PREVIEW_C"); RES_ESC=${RES//\'/\'\'}
  # Dry-run only: nothing was written, so clubdesk_push_pending stays set for a real
  # commit later. Do NOT touch members here.
  cdp 100 "$DRY_MSG"
  psqlc "UPDATE clubdesk_member_sync SET up_state='done', up_requested_at=NULL, up_finished_at=now(), up_message='${DRY_MSG_ESC}', up_result='${RES_ESC}'::jsonb, ${CLEAR_COLS} WHERE id=1"
  echo "=== up-dispatch: dry-run OK, commit disabled ==="; exit 0
fi

# ── Commit phase: CREATE set first ────────────────────────────────────────────
# A re-pushed CREATE row DUPLICATES the contact, a re-pushed UPDATE row is
# idempotent — so commit the risky set first and stamp its members immediately.
RES_C=''
if [ -s "$CSVUTF_C" ]; then
  cdp 58 "Writing the new contacts to ClubDesk…"
  RES_C=$(scrape "$CSV_C" commit)
  echo "commit (create set): $RES_C"
  if ! printf '%s' "$RES_C" | grep -q '"committed":true'; then
    fail_run 'Push failed (create set) — see up-run.log' "$RES_C"
    echo "=== up-dispatch: FAILED (create set) ==="; exit 0
  fi
  # Stamp the creates NOW (duplicate protection): even if the update-set commit
  # below fails, these contacts exist in ClubDesk and must never be re-offered
  # as creates. The stamp doubles as the "pushed, awaiting link" marker until
  # the next sync-down's auto-linker sets clubdesk_id.
  # TODO write-back: scrape the new ClubDesk [Id] for these rows instead.
  #
  # Audit #10: a create commit succeeded but a silenced stamp failure ('|| true')
  # is the ONE state that must never pass quietly — the contacts exist in ClubDesk
  # yet stay eligible, so the next push DUPLICATES them. Capture the stamp's exit
  # status and fail the run loudly (the creates are committed; the operator must
  # NOT retry until a sync-down links them). Do not proceed to the update set.
  if ! psqlc "UPDATE members SET clubdesk_pushed_at=now() WHERE id IN (SELECT jsonb_array_elements_text(up_member_ids_create)::int FROM clubdesk_member_sync WHERE id=1)" >/dev/null 2>&1; then
    fail_run 'CREATE set committed in ClubDesk but stamping clubdesk_pushed_at FAILED — do NOT retry until a sync-down links the new contacts (else duplicates)' "$RES_C"
    echo "=== up-dispatch: FAILED (create-stamp; contacts committed but unstamped) ===" >&2; exit 1
  fi
fi

RES_U=''
if [ -s "$CSVUTF_U" ]; then
  cdp 78 "Writing the changed members to ClubDesk…"
  RES_U=$(scrape "$CSV_U" commit)
  echo "commit (update set): $RES_U"
  if ! printf '%s' "$RES_U" | grep -q '"committed":true'; then
    # Creates (if any) are committed + stamped above; the update members keep
    # clubdesk_push_pending and are retried on the next push.
    #
    # ⚠ The message MUST distinguish the two cases. It used to assert "create set
    # was committed" unconditionally, and most failed runs carry NO create set at
    # all ($RES_C empty) — so the operator was told new contacts had been written
    # into the legal register when nothing had, and went hunting for phantom
    # duplicates. 2026-08-30: exactly that, on a one-row update push.
    RES=$(merge_results false "$RES_U" "$RES_C")
    if [ -n "$RES_C" ]; then
      fail_run 'Push failed (update set) — the CREATE set WAS committed and stamped; do not re-create those contacts. See up-run.log' "$RES"
    else
      fail_run 'Push failed (update set) — nothing was written to ClubDesk. The members stay flagged and go again on the next push. See up-run.log' "$RES"
    fi
    echo "=== up-dispatch: FAILED (update set) ==="; exit 0
  fi
fi

cdp 92 "Clearing the push flags…"
RES=$(merge_results true "$RES_U" "$RES_C"); RES_ESC=${RES//\'/\'\'}
# 3a. Stamp EVERY pushed member with clubdesk_pushed_at (creates were already
#     stamped right after their commit; this re-stamp is harmless and also covers
#     the update set).
psqlc "UPDATE members SET clubdesk_pushed_at=now() WHERE id IN (SELECT jsonb_array_elements_text(up_member_ids)::int FROM clubdesk_member_sync WHERE id=1)" >/dev/null 2>&1 || true
# 3b. Clear the pending flag ONLY for members whose edit-set is the one we actually
#     pushed. A member edited again BETWEEN the stash (up_requested_at) and this push
#     has a newer date_updated, so we KEEP clubdesk_push_pending=true and their newer
#     edit is picked up on the next run instead of being silently dropped.
psqlc "UPDATE members m SET clubdesk_push_pending=false, clubdesk_push_changes=NULL FROM clubdesk_member_sync s WHERE s.id=1 AND m.id IN (SELECT jsonb_array_elements_text(s.up_member_ids)::int) AND (m.date_updated IS NULL OR m.date_updated <= s.up_requested_at)" >/dev/null 2>&1 || true
cdp 100 "Pushed to ClubDesk"
psqlc "UPDATE clubdesk_member_sync SET up_state='done', up_requested_at=NULL, up_finished_at=now(), up_message='Pushed to ClubDesk', up_result='${RES_ESC}'::jsonb, ${CLEAR_COLS} WHERE id=1"
echo "=== up-dispatch: done ==="
