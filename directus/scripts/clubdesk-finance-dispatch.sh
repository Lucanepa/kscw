#!/usr/bin/env bash
# Host dispatcher for the in-app "Sync now" button (cron, every minute).
# Claims a queued request from finance_ledger_settings, runs the finance sync, and
# writes back the state the button polls. flock keeps a single dispatcher at a time.
set -uo pipefail
DIR=/opt/clubdesk-sync
PG=kscw-postgres
DB="${DB:-postgres}"

exec 9>"$DIR/.dispatch.lock"
flock -n 9 || exit 0   # a previous dispatcher is still running

psqlc() { docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -tAc "$1"; }

# Recover a stuck 'running' (a dispatch that died mid-sync) so it can't block forever.
psqlc "UPDATE finance_ledger_settings SET sync_state='idle', sync_requested_at=NULL, sync_message='Reset (stale run)' WHERE id=1 AND sync_state='running' AND sync_requested_at < now() - interval '15 minutes'" >/dev/null 2>&1 || true

# Atomically claim a queued request. CTE so the top-level statement is a SELECT —
# a bare UPDATE…RETURNING via psql -tAc also prints the "UPDATE 1" command tag.
claim=$(psqlc "WITH u AS (UPDATE finance_ledger_settings SET sync_state='running' WHERE id=1 AND sync_requested_at IS NOT NULL AND sync_state <> 'running' RETURNING 1) SELECT count(*) FROM u" 2>/dev/null || echo 0)
[ "$claim" = "1" ] || exit 0

echo "=== dispatch: finance sync requested — running $(TZ=Europe/Zurich date +'%d.%m.%Y %H:%M:%S') ==="
if /opt/clubdesk-sync/clubdesk-finance-sync.sh; then
  psqlc "UPDATE finance_ledger_settings SET sync_state='done', sync_requested_at=NULL, sync_finished_at=now(), sync_message='Synced from ClubDesk' WHERE id=1"
  echo "=== dispatch: done ==="
else
  psqlc "UPDATE finance_ledger_settings SET sync_state='failed', sync_requested_at=NULL, sync_finished_at=now(), sync_message='Sync failed — see finance-last-run.log' WHERE id=1"
  echo "=== dispatch: FAILED ==="
fi
