#!/usr/bin/env bash
#
# refresh-dev-daily.sh — VPS-side DAILY cron: overwrite the dev database with a
# scrubbed copy of prod, so dev keeps realistic data for testing.
#
# This is the UNATTENDED sibling of refresh-dev-from-prod.sh:
#   • refresh-dev-from-prod.sh runs FROM a dev machine (SSHes in, then runs
#     `npm run db:migrate:dev` to reconcile dev-ahead schema).
#   • THIS script runs ON the Hetzner VPS as root (cron), fully self-contained —
#     no SSH-to-self, no node/npm. It mirrors that script's VPS-side phase
#     MINUS the migrate reconcile.
#
# Canonical source: repo  directus/scripts/refresh-dev-daily.sh
# Deploy to VPS:     npm run scripts:deploy:dev   (-> /opt/directus-kscw-dev/scripts/)
# Root crontab (UTC):
#   0 3 * * * bash /opt/directus-kscw-dev/scripts/refresh-dev-daily.sh >> /data/backups/refresh-dev-daily.log 2>&1
#
# Why no migrate reconcile: the prod clone carries prod's COMPLETE, consistent
# schema + its kscw_migrations tracker, so post-clone dev == prod (fully
# migrated). The only case the reconcile would matter is dev-branch schema
# AHEAD of prod (active migration development); that work is transient under a
# daily wipe anyway. During active schema dev, either pause this cron or re-run
# `npm run db:deploy:dev` after a nightly sync.
#
# Safety: a dev safety-dump is taken FIRST (7-day local retention). On an empty
# dump, a failed row-count gate, or a failed PII scrub, the script restores dev
# from that safety dump and restarts it (so dev stays online on prior-day data
# and unscrubbed prod PII is never served). If even the restore fails, dev is
# left STOPPED and the run exits non-zero — check this log.
#
set -uo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin:${PATH:-}

PGC=kscw-postgres
PROD_DB=postgres
DEV_DB=directus_kscw_dev
DEV_CONTAINER=directus-kscw-dev
BACKUP_DIR=/data/backups
RETENTION_DAYS=7

TS=$(date +%F_%H%M%S)
BACKUP="$BACKUP_DIR/kscw_dev_pre-refresh_${TS}.sql.gz"
CREDS="/tmp/refresh_devcreds_${TS}.txt"
SCRUB="/tmp/refresh_scrub_${TS}.sql"
REPIN="/tmp/refresh_repin_${TS}.sql"
RLOG="/tmp/refresh_restore_${TS}.log"

log(){ echo "[$(date -u +%F_%H:%M:%SZ)] $*"; }

# Emails kept REAL after scrub (admin/cron logins + OAuth accounts). Used both
# as the scrub allowlist and as the re-pin filter. Keep in sync with
# refresh-dev-from-prod.sh.
ALLOW_SQL="'admin@kscw.ch','aniish.k@hotmail.com','anja_jimenez@hotmail.com','cron-service@kscw.ch','luca.canepa@gmail.com','thamayanth.kanagalingam@uzh.ch'"

# Restore dev from the safety dump + restart it. Used on any post-wipe failure
# so an unattended run never leaves dev down (or serving unscrubbed PII).
rollback(){
  log "ROLLBACK: restoring dev from safety dump $BACKUP"
  if [ ! -s "$BACKUP" ]; then
    log "ROLLBACK ABORTED: safety dump missing/empty — dev left STOPPED."
    return 1
  fi
  docker exec "$PGC" psql -U supabase_admin -d "$DEV_DB" -v ON_ERROR_STOP=1 </dev/null \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO supabase_admin; GRANT USAGE ON SCHEMA public TO anon, authenticated;" >/dev/null 2>&1
  if zcat "$BACKUP" | docker exec -i "$PGC" psql -U supabase_admin -d "$DEV_DB" -q >/dev/null 2>&1; then
    docker start "$DEV_CONTAINER" >/dev/null </dev/null 2>&1 || true
    log "ROLLBACK OK: dev restored to prior-day data + restarted."
    return 0
  fi
  log "ROLLBACK FAILED: dev left STOPPED. Safety dump: $BACKUP"
  return 1
}

log "===== refresh-dev-daily START (prod=$PROD_DB -> dev=$DEV_DB) ====="

log "[1/7] Capturing dev service-account creds (for re-pin after clone)"
# id is captured FIRST and used as the re-pin key: it survives the PII scrub
# (which rewrites emails), so both allowlist service accounts AND token-holding
# members (e.g. the db:smoke test member) get their token restored.
docker exec "$PGC" psql -U supabase_admin -d "$DEV_DB" -t -A -F'|' </dev/null \
  -c "SELECT id, email, coalesce(password,''), coalesce(token,'') FROM directus_users WHERE token IS NOT NULL OR lower(email) IN ($ALLOW_SQL);" \
  > "$CREDS" 2>/dev/null || true

log "[2/7] Safety snapshot of dev -> $BACKUP"
docker exec "$PGC" pg_dump -U supabase_admin -d "$DEV_DB" --no-owner --no-acl </dev/null | gzip > "$BACKUP"
if [ ! -s "$BACKUP" ]; then
  log "!! Safety dump failed/empty — aborting BEFORE touching dev (dev untouched)."
  rm -f "$CREDS"; exit 1
fi
log "      $(ls -lh "$BACKUP" | awk '{print $5}')"

log "[3/7] Stopping dev Directus + recreating public schema"
docker stop "$DEV_CONTAINER" >/dev/null </dev/null
docker exec "$PGC" psql -U supabase_admin -d "$DEV_DB" -v ON_ERROR_STOP=1 </dev/null \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DEV_DB' AND pid<>pg_backend_pid();" >/dev/null
docker exec "$PGC" psql -U supabase_admin -d "$DEV_DB" -v ON_ERROR_STOP=1 </dev/null \
  -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO supabase_admin; GRANT USAGE ON SCHEMA public TO anon, authenticated;" >/dev/null

# ⚠⚠ EXTENSIONS ARE NOT IN THE DUMP. `DROP SCHEMA public CASCADE` above takes
# every extension installed into that schema with it, and `pg_dump -n public`
# never emits CREATE EXTENSION (extensions are database-level objects, excluded
# by a schema filter). So each refresh left dev without `unaccent` and the
# ClubDesk sync-down died on the accent-insensitive linker pass every day
# (`function unaccent(text) does not exist`).
#
# ⚠ refresh-dev-from-prod.sh — the attended sibling — has carried this block
# since 25.08.2026 and THIS script did not, which is why the fix looked like it
# worked: running the manual refresh by hand put the extension back, the nightly
# cron took it away again, and the sync-down failed the next day (08.09.2026).
# Whatever is added to one of these two scripts belongs in the other.
#
# ⚠ A migration CANNOT fix this on its own: `kscw_migrations` lives in the public
# schema, so the clone restores PROD's tracker, which already lists the migration
# as applied. The runner would skip it forever while the extension stayed gone.
log "[3b/7] Recreating database-level extensions (not carried by a schema-only dump)"
for ext in unaccent; do
  if docker exec "$PGC" psql -U supabase_admin -d "$DEV_DB" -v ON_ERROR_STOP=1 </dev/null \
       -c "CREATE EXTENSION IF NOT EXISTS $ext;" >/dev/null 2>&1; then
    log "     ok $ext"
  else
    # Not fatal: the rest of dev works without it. Loud, because the thing it
    # breaks (the ClubDesk sync-down) fails minutes later with an error that
    # points at SQL rather than at this.
    log "     WARN $ext FAILED — the ClubDesk sync-down will break on dev"
  fi
done

log "[4/7] Cloning prod -> dev (public schema)"
docker exec "$PGC" pg_dump -U supabase_admin -d "$PROD_DB" -n public --no-owner --no-acl </dev/null \
  | docker exec -i "$PGC" psql -U supabase_admin -d "$DEV_DB" -q -v ON_ERROR_STOP=0 > "$RLOG" 2>&1 || true

log "[5/7] Verifying restore (row-count gate)"
fail=0
for chk in members:400 teams:25 trainings:400 games:300; do
  t=${chk%%:*}; min=${chk##*:}
  c=$(docker exec "$PGC" psql -U supabase_admin -d "$DEV_DB" -t -A </dev/null -c "SELECT count(*) FROM $t;" 2>/dev/null || echo X)
  log "      $t = $c (min $min)"
  if [ "$c" = X ] || ! [ "$c" -ge "$min" ] 2>/dev/null; then fail=1; fi
done
if [ "$fail" -eq 1 ]; then
  log "!! Restore verification FAILED — rolling back."
  rollback || true
  rm -f "$SCRUB" "$REPIN" "$CREDS"
  exit 1
fi

# Clear the cloned Directus license so dev runs keyless (Core/grace) and never
# re-activates. The clone carries prod's license_key/license_token encrypted with
# PROD's KEY/SECRET — dev can't decrypt them and would re-activate from the env
# LICENSE_KEY, burning a fresh activation slot every night until the 5-activation
# cap is exhausted (dev crash-loops on "Activation limit exceeded"). Dev has no
# LICENSE_KEY in its .env (commented out 2026-07-15), so nulling these keeps dev
# in the 30-day Core grace period, which resets on every nightly clone. Prod is
# untouched.
log "[5b/7] Clearing cloned license (dev runs keyless / Core grace)"
docker exec "$PGC" psql -U supabase_admin -d "$DEV_DB" </dev/null \
  -c "UPDATE directus_settings SET license_key=NULL, license_token=NULL;" >/dev/null 2>&1 || true

log "[6/7] Scrubbing PII"
cat > "$SCRUB" <<'SQL'
BEGIN;

-- Members (real player PII)
UPDATE members SET email    = 'member_' || id || '@devsink.invalid' WHERE email IS NOT NULL AND email <> '';
UPDATE members SET vm_email = NULL WHERE vm_email IS NOT NULL;
UPDATE members SET phone    = NULL WHERE phone IS NOT NULL;

-- Directus login accounts (keep admin/dev logins on the allowlist)
UPDATE directus_users
   SET email = 'user_' || id || '@devsink.invalid'
 WHERE email IS NOT NULL
   AND lower(email) NOT IN (
     'admin@kscw.ch','aniish.k@hotmail.com','anja_jimenez@hotmail.com',
     'cron-service@kscw.ch','luca.canepa@gmail.com','thamayanth.kanagalingam@uzh.ch'
   );

-- ClubDesk: {basketball,people,volleyball} are VIEWS over clubdesk_export — scrub the base only
UPDATE clubdesk_export SET
  email            = CASE WHEN email IS NOT NULL AND email<>'' THEN 'scrub_'||substr(md5(email),1,16)||'@devsink.invalid' ELSE email END,
  email_alternativ = CASE WHEN email_alternativ IS NOT NULL AND email_alternativ<>'' THEN 'scrub_'||substr(md5(email_alternativ),1,16)||'@devsink.invalid' ELSE email_alternativ END;

-- Other contact tables
UPDATE event_signups             SET email         = 'scrub_'||substr(md5(email),1,16)||'@devsink.invalid'         WHERE email IS NOT NULL AND email<>'';
UPDATE feedback                  SET email         = 'scrub_'||substr(md5(email),1,16)||'@devsink.invalid'         WHERE email IS NOT NULL AND email<>'';
UPDATE game_scheduling_opponents SET contact_email = 'scrub_'||substr(md5(contact_email),1,16)||'@devsink.invalid' WHERE contact_email IS NOT NULL AND contact_email<>'';
UPDATE newsletter_subscribers    SET email         = 'scrub_'||substr(md5(email),1,16)||'@devsink.invalid'         WHERE email IS NOT NULL AND email<>'';
UPDATE registrations             SET email         = 'scrub_'||substr(md5(email),1,16)||'@devsink.invalid'         WHERE email IS NOT NULL AND email<>'';
UPDATE sv_vm_check               SET email         = 'scrub_'||substr(md5(email),1,16)||'@devsink.invalid'         WHERE email IS NOT NULL AND email<>'';
UPDATE svrz_spielplaner_contacts SET contact_email = CASE WHEN contact_email IS NOT NULL AND contact_email<>'' THEN 'scrub_'||substr(md5(contact_email),1,16)||'@devsink.invalid' ELSE contact_email END,
                                     contact_phone = NULL;
UPDATE vm_vb_spielplan_contact   SET "Email"       = 'scrub_'||substr(md5("Email"),1,16)||'@devsink.invalid'       WHERE "Email" IS NOT NULL AND "Email"<>'';

-- Mailbox credentials (Emails Garage, migration 326).
-- ⚠⚠ The INVENTORY is useful on dev; the CIPHERTEXT is not. Without this, a
-- clone hands dev every club mailbox password, and the only thing standing
-- between dev and plaintext is EMAIL_VAULT_KEY differing between the two
-- containers — a one-line env mistake away from being the same key. Null the
-- column instead so the question cannot arise: dev's page lists the accounts
-- and honestly reports "no password stored".
-- ⚠ Keep in sync with refresh-dev-from-prod.sh, which carries the same block.
UPDATE email_accounts SET password_enc = NULL WHERE password_enc IS NOT NULL;

-- Devices / transient state
TRUNCATE push_subscriptions;
DELETE FROM email_verifications;
DELETE FROM directus_sessions;

COMMIT;
SQL
if ! docker exec -i "$PGC" psql -U supabase_admin -d "$DEV_DB" -v ON_ERROR_STOP=1 -q < "$SCRUB"; then
  log "!! Scrub FAILED — rolling back (unscrubbed prod data must NOT be served)."
  rollback || true
  rm -f "$SCRUB" "$REPIN" "$CREDS" "$RLOG"
  exit 1
fi
docker exec "$PGC" psql -U supabase_admin -d "$DEV_DB" </dev/null \
  -c "UPDATE directus_settings SET project_url='https://wiedisync.pages.dev' WHERE project_url IS NOT NULL;" >/dev/null 2>&1 || true

log "[7/7] Re-pinning dev creds by id (allowlist passwords + all captured tokens)"
# Fields: $1=id  $2=email  $3=password  $4=token.
# Key on id (not email) so member tokens survive the email scrub. Passwords are
# re-pinned for allowlist service accounts only; tokens for every captured row
# (allowlist service tokens + member smoke tokens alike).
awk -F'|' '
  BEGIN{
    a["admin@kscw.ch"]=1;a["cron-service@kscw.ch"]=1;a["luca.canepa@gmail.com"]=1;
    a["aniish.k@hotmail.com"]=1;a["anja_jimenez@hotmail.com"]=1;a["thamayanth.kanagalingam@uzh.ch"]=1;
  }
  function q(s){ gsub(/\047/,"\047\047",s); return "\047" s "\047" }
  ($1!=""){
    s="";
    if((tolower($2) in a) && $3!=""){ s="password=" q($3) }
    if($4!=""){ if(s!="") s=s", "; s=s "token=" q($4) }
    if(s!="") printf "UPDATE directus_users SET %s WHERE id=%s;\n", s, q($1)
  }
' "$CREDS" > "$REPIN"
if ! docker exec -i "$PGC" psql -U supabase_admin -d "$DEV_DB" -v ON_ERROR_STOP=1 -q < "$REPIN"; then
  log "   (warning: some re-pins failed; admin/cron login on dev may need attention)"
fi

docker start "$DEV_CONTAINER" >/dev/null </dev/null
rm -f "$SCRUB" "$REPIN" "$CREDS" "$RLOG"

# Retention: keep only the last RETENTION_DAYS of pre-refresh safety dumps.
find "$BACKUP_DIR" -name 'kscw_dev_pre-refresh_*.sql.gz' -mtime +"$RETENTION_DAYS" -delete 2>/dev/null || true

log "===== refresh-dev-daily DONE. Dev restarted. Safety backup: $BACKUP ====="
