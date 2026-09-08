#!/usr/bin/env bash
# Nightly ClubDesk Finanz → Directus finance import (invoices + bookings).
#
# Counterpart of clubdesk-sync.sh (the weekly member sync). Scrapes the two Finanz
# CSVs (Rechnungen "Alle Spalten" + Buchhaltung), then imports them via
# import-clubdesk-finance.mjs --emit-sql and applies the SQL with ON_ERROR_STOP.
# Lives on the VPS at /opt/clubdesk-sync/ alongside the scraper + importer; wired
# to a nightly cron. Mirror of the repo copy (directus/scripts/).
#
# ⚠ CSVs hold member PII (IBAN/AHV) — the EXIT trap deletes them; never let them linger.
# ⚠ One ClubDesk session per account — runs on a dedicated service account.
set -euo pipefail
DIR=/opt/clubdesk-sync
# Single sync at a time (nightly cron + the on-demand dispatcher share this lock).
exec 8>"$DIR/.sync.lock"
flock -n 8 || { echo "another finance sync is running — skipping"; exit 0; }
PW_IMG=mcr.microsoft.com/playwright:v1.60.0-jammy
NODE_IMG=node:20-bookworm
PG=kscw-postgres
ENVNAME="${CLUBDESK_ENV:-prod}"
case "$ENVNAME" in
  prod) DB=postgres ;;
  dev)  DB=directus_kscw_dev ;;
  *) echo "bad CLUBDESK_ENV: $ENVNAME (expected dev|prod)" >&2; exit 1 ;;
esac
INV="$DIR/clubdesk-rechnungen.csv"
BOOK="$DIR/clubdesk-buchhaltung.csv"
SQL="$DIR/finance-import.sql"
cleanup() { rm -f "$INV" "$BOOK" "$SQL"; }
trap cleanup EXIT

echo "=== ClubDesk finance sync start $(TZ=Europe/Zurich date +'%d.%m.%Y %H:%M:%S') (env=$ENVNAME db=$DB) ==="
docker run --rm -w /work -v "$DIR":/work --env-file "$DIR/.env" "$PW_IMG" \
  node /work/clubdesk-scrape-finance.mjs /work/clubdesk-rechnungen.csv /work/clubdesk-buchhaltung.csv
docker run --rm -w /work -v "$DIR":/work "$NODE_IMG" \
  node /work/import-clubdesk-finance.mjs "$ENVNAME" /work/clubdesk-rechnungen.csv /work/clubdesk-buchhaltung.csv --emit-sql > "$SQL"
docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -v ON_ERROR_STOP=1 < "$SQL"
echo "=== ClubDesk finance sync done $(TZ=Europe/Zurich date +'%d.%m.%Y %H:%M:%S') ==="
