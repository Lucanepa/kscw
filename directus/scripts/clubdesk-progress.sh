#!/usr/bin/env bash
# clubdesk-progress.sh — live progress + a log tail for the three ClubDesk jobs.
#
# Sourced by clubdesk-member-dispatch.sh, clubdesk-member-up-dispatch.sh and
# clubdesk-group-fix-dispatch.sh. Every one of them already writes a state and a
# final message; this adds the two things the operator actually asked for while a
# five-minute scrape runs — WHERE it is and WHAT it just said (migration 355).
#
# The caller sets three variables before sourcing:
#   PG       the postgres container name
#   DB       the target database (already derived from CLUBDESK_ENV)
#   CDP_JOB  down | up | grp   — picks the <job>_phase/<job>_progress/<job>_log trio
#
# and then calls:
#   cdp_reset                 once, right after claiming the job
#   cdp <pct> <message…>      at each phase boundary it knows about
#   cdp_stream                in a pipeline, to follow a child's output live
#
# ⚠ BEST EFFORT, ALWAYS. Every write ends in `|| true` and every function returns 0.
# Progress is something to look at, never something a run depends on: a dispatcher
# that failed because it could not report its own progress would be a strictly
# worse dispatcher. The state columns remain the only correctness signal.
#
# ⚠ The log column is a TAIL (last CDP_KEEP lines, hard-capped), not an archive.
# The full run output stays in the host log files. It exists so the superadmin who
# pressed the button can read the scraper's own words without SSH — the same gap
# that made a failed sync say only "see the member sync log" until 2026-08-25.

CDP_KEEP=${CDP_KEEP:-25}          # lines kept in the DB column
CDP_MAX_BYTES=${CDP_MAX_BYTES:-6000}
CDP_MIN_INTERVAL=${CDP_MIN_INTERVAL:-2}   # seconds between throttled writes
CDP_BUF="$(mktemp)"
CDP_LAST_WRITE=0
CDP_PCT=0
CDP_PHASE=''
# The buffer is this process's own scratch — remove it on exit without stomping a
# trap the caller may already own (the member dispatcher traps its RUNLOG).
cdp_cleanup() { rm -f "$CDP_BUF"; }

# The one place that talks to Postgres. `-v` + `:'…'` rather than string
# interpolation: a scraper error can quote page content, and psql's own quoting is
# the only escaping here that is not a guess.
cdp_write() {
  local lg
  lg="$(tail -n "$CDP_KEEP" "$CDP_BUF" 2>/dev/null | tail -c "$CDP_MAX_BYTES")"
  docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -q \
    -v pct="$CDP_PCT" -v phase="$CDP_PHASE" -v lg="$lg" \
    -c "UPDATE clubdesk_member_sync SET ${CDP_JOB}_progress = NULLIF(:'pct','')::smallint, ${CDP_JOB}_phase = NULLIF(:'phase',''), ${CDP_JOB}_log = NULLIF(:'lg','') WHERE id = 1" \
    >/dev/null 2>&1 || true
  CDP_LAST_WRITE=$(date +%s)
  return 0
}

# The log alone — deliberately NOT the bar.
#
# ⚠ cdp_stream runs in a PIPELINE, i.e. a subshell, so its CDP_PCT is a private
# copy of whatever the parent had when the pipeline started. A plain output line
# writing that copy back would drag the bar backwards every time the parent had
# moved on (the up dispatcher advances the phase itself while the scraper's stderr
# is still arriving). Whoever owns the phase owns the number; the stream only ever
# owns the words.
cdp_write_log() {
  local lg
  lg="$(tail -n "$CDP_KEEP" "$CDP_BUF" 2>/dev/null | tail -c "$CDP_MAX_BYTES")"
  docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -q -v lg="$lg" \
    -c "UPDATE clubdesk_member_sync SET ${CDP_JOB}_log = NULLIF(:'lg','') WHERE id = 1" \
    >/dev/null 2>&1 || true
  CDP_LAST_WRITE=$(date +%s)
  return 0
}

# Append one line to the tail buffer. Trimmed and length-capped: a Playwright error
# can be thousands of characters on one line, and a column nobody can read is the
# same as no column.
cdp_append() {
  printf '%s\n' "$1" | tr -d '\r' | cut -c1-220 >> "$CDP_BUF" 2>/dev/null || true
  return 0
}

# Clear the trio so a new run never shows the previous run's log for the seconds
# before its first phase lands.
cdp_reset() {
  : > "$CDP_BUF"
  CDP_PCT=0
  CDP_PHASE=''
  docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -q \
    -c "UPDATE clubdesk_member_sync SET ${CDP_JOB}_progress = 0, ${CDP_JOB}_phase = NULL, ${CDP_JOB}_log = NULL WHERE id = 1" \
    >/dev/null 2>&1 || true
  return 0
}

# A phase boundary the dispatcher itself knows about: always written immediately,
# never throttled — these are the transitions the bar is made of.
cdp() {
  CDP_PCT="$1"; shift
  CDP_PHASE="$*"
  cdp_append "$CDP_PHASE"
  cdp_write
  return 0
}

# A run that died: say WHERE it died, and leave the bar exactly where it stopped.
#
# ⚠ Never re-writes the number. The dispatcher's own CDP_PCT is a stale copy the
# moment cdp_stream (a subshell) has been lifting markers, so writing it back here
# would rewind a bar that reached 60% to the last value the parent set — 2%. The
# phase reads "Failed: …" and the bar reads where it got to, which together are the
# whole diagnosis.
cdp_fail() {
  CDP_PHASE="Failed: $*"
  cdp_append "$CDP_PHASE"
  local lg
  lg="$(tail -n "$CDP_KEEP" "$CDP_BUF" 2>/dev/null | tail -c "$CDP_MAX_BYTES")"
  docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -q \
    -v phase="$CDP_PHASE" -v lg="$lg" \
    -c "UPDATE clubdesk_member_sync SET ${CDP_JOB}_phase = NULLIF(:'phase',''), ${CDP_JOB}_log = NULLIF(:'lg','') WHERE id = 1" \
    >/dev/null 2>&1 || true
  return 0
}

# Follow a child process's output live:  child 2>&1 | cdp_stream | tee "$RUNLOG"
#
# Passes every line straight through (so the host log and the caller's failure
# parsing see exactly what they saw before) and mirrors it into the DB tail. Lines
# shaped `@@STEP <pct> <message>` are progress markers emitted by the scrapers —
# they set the bar and are shown as the phase, with the marker syntax stripped.
#
# ⚠ Throttled to one write per CDP_MIN_INTERVAL for ordinary lines, but a marker
# always writes. A chatty scraper must not turn into a psql call per line.
cdp_stream() {
  local line now
  while IFS= read -r line; do
    printf '%s\n' "$line"
    if [[ "$line" == @@STEP\ * ]]; then
      local rest=${line#@@STEP }
      local pct=${rest%% *}
      local msg=${rest#* }
      case "$pct" in
        ''|*[!0-9]*) cdp_append "$line" ;;
        *) CDP_PCT="$pct"; CDP_PHASE="$msg"; cdp_append "$msg"; cdp_write ;;
      esac
      continue
    fi
    cdp_append "$line"
    now=$(date +%s)
    if [ $((now - CDP_LAST_WRITE)) -ge "$CDP_MIN_INTERVAL" ]; then cdp_write_log; fi
  done
  # Whatever the last lines were, they belong in the column — the throttle must not
  # swallow the final (and most interesting) output of a run that just failed.
  cdp_write_log
  return 0
}
