#!/usr/bin/env bash
# clubdesk-group-cleanup.sh — Weekly auto-removal of stale ClubDesk player-group
# allocations. Counterpart to the on-demand add tool: it keeps group hygiene
# hands-off for the cases where "this allocation is wrong" is unambiguous.
#
# Two removal classes, both mirroring clubdesk-update.js (the source of truth):
#
# 1. STRAY (straySql) — a member whose ClubDesk contact is in a '<team>
#    (Spieler*in)' group that maps to a real Wiedisync team, but who has NO
#    member_teams row for the current season. The bucket is already narrow: player
#    groups only, BB-league umbrellas excluded (clubdesk_group=''), and ANY roster
#    row (incl. guest) disqualifies. Envelope below.
#
# 2. STALE FUNKTION (staleFunktionSql, added 2026-07-30) — a member who IS on the
#    team but whose contact holds the OTHER Funktion for that same group:
#    '(Spieler*in)' while wiedisync says guest, or the reverse. Neither existing
#    check could see it — `missing` only reports an ABSENT expected token, and a
#    stray needs ZERO roster rows, which excludes every guest by construction — so
#    since both assignment paths only ever ADD, 29 contacts had quietly accumulated
#    both allocations by the time it was found.
#    ⚠ This class needs NO departure/staff test: wiedisync owns guest status
#      outright (the sync is deliberately one-way — see clubdesk-update.js), so a
#      Funktion that contradicts a CURRENT roster row is wrong by definition, not
#      ambiguous like a stray.
#    ⚠ But it removes ONLY when the CORRECT token is already present alongside.
#      Removing the last token would drop the member out of their team's group
#      entirely until a human re-adds it — worse than the contradiction. Those rows
#      stay visible in the Consistency check (and in `missing`) for a manual swap.
#
# AUTO-REMOVE ENVELOPE for STRAYS (user-approved 2026-07-16, departure test
# corrected 2026-07-27) — remove only where it's safe to act unattended:
#   • HAS LEFT the club → lingering in a team's player group is pure staleness.
#                     Remove. "Left" = ClubDesk's own register says so (status
#                     Kein Mitglied / Ehemaliges Mitglied / Verstorben, or an
#                     Austritt date) or wiedisync's kscw_membership_active=false.
#   • still a member AND (coach OR team-responsible) → the "Lasse pattern": they staff
#                     a team but play on none this season, so their player group is
#                     stale (they keep their (Trainer*in) group). Remove.
#   • still a member, NOT coach/TR (plain player or bare official) → AMBIGUOUS: usually
#                     a MISSING ROSTER ROW in Wiedisync, not a wrong ClubDesk group.
#                     LEFT UNTOUCHED for the manual consistency-check card.
#
# ⚠ The departure test used to be `wiedisync_active=false`, which does NOT mean "left
#   the club" — it means "has never activated a wiedisync login", true for ~500 of 709
#   members (juniors especially). Combined with a team whose roster was never entered,
#   that wiped 29 DU20 girls out of ClubDesk on 2026-07-16 (group-cleanup-commit.log);
#   the 06.07 clubdesk_export backup was the only surviving copy. Membership status is
#   the only thing this may key on — never app activation.
#
# Runs the proven clubdesk-remove-group.mjs (detail-view chip ×, verify-before-save)
# under the shared .sync.lock, exactly like the add/import scrapers.
#
# Install at /opt/clubdesk-sync/ and wire to root crontab AFTER the weekly down-sync
# (Sat 22:00 UTC) so clubdesk_export reflects the latest ClubDesk state:
#   0 6 * * 0 CLUBDESK_ENV=prod CLUBDESK_CLEANUP_COMMIT=1 /opt/clubdesk-sync/clubdesk-group-cleanup.sh >> /opt/clubdesk-sync/group-cleanup.log 2>&1
#
# ⚠ Commit WRITES to the club's legal member record. It is gated behind CLUBDESK_ENV=prod
#   AND CLUBDESK_CLEANUP_COMMIT=1 (default = dry-run preview); dev is ALWAYS forced to
#   preview (single shared ClubDesk account, no dev instance).
# ⚠ Runaway guards: aborts if <20 member_teams rows exist for the season (a DB glitch
#   would make every player-group member look like a stray), and if the computed
#   removal set exceeds CAP (default 75) — a normal week is 0–3; the stray catch-up
#   run was ~49, the stale-Funktion one is 29. A stale/partial clubdesk_export only ever UNDER-counts (safe), and the
#   remove tool no-ops (skip_not_in_group) on anyone already out of the group.
set -uo pipefail
DIR=/opt/clubdesk-sync
PG=kscw-postgres
PW_IMG=mcr.microsoft.com/playwright:v1.60.0-jammy
CAP="${CLUBDESK_CLEANUP_CAP:-75}"

CLUBDESK_ENV="${CLUBDESK_ENV:-prod}"
case "$CLUBDESK_ENV" in
  prod) DB=postgres ;;
  dev)  DB=directus_kscw_dev ;;
  *) echo "FATAL: bad CLUBDESK_ENV '$CLUBDESK_ENV' (expected dev|prod)" >&2; exit 1 ;;
esac
export CLUBDESK_ENV

# Per-env self-exclusion (the ClubDesk scrape itself serialises on .sync.lock below).
exec 9>"$DIR/.group-cleanup-${DB}.lock"
flock -n 9 || exit 0

psqlc() { docker exec -i "$PG" psql -U supabase_admin -d "$DB" -X -tAc "$1"; }

# Current season — mirror getCurrentSeason() in clubdesk-update.js exactly:
# Jun–Dec → "Y/Y+1", Jan–May → "Y-1/Y".
Y=$(date -u +%Y); M=$(date -u +%-m)
if [ "$M" -ge 6 ]; then SEASON="$Y/$(printf '%02d' $(( (Y + 1) % 100 )))"; else SEASON="$((Y - 1))/$(printf '%02d' $(( Y % 100 )))"; fi

echo "=== group-cleanup $(TZ=Europe/Zurich date +'%d.%m.%Y %H:%M:%S') (db=$DB, season=$SEASON, cap=$CAP) ==="

# Runaway guard 1: the season must be populated, else strays = the whole club
# (and the stale-Funktion join has nothing to anchor on either).
MT=$(psqlc "SELECT count(*) FROM member_teams WHERE season='$SEASON'" 2>/dev/null || echo 0)
if [ "${MT:-0}" -lt 20 ]; then
  echo "ABORT: only ${MT:-0} member_teams rows for $SEASON (<20) — refusing to compute strays."; exit 1
fi

# Shared removal CTE — `strays` mirrors clubdesk-update.js straySql + the approved
# envelope; `stale` mirrors staleFunktionSql (both-tokens-present case only).
CTE="
WITH cd_groups AS (
  SELECT BTRIM(ce.clubdesk_id) AS clubdesk_id, BTRIM(g) AS grp
  FROM clubdesk_export ce, LATERAL unnest(string_to_array(ce.gruppen_bracketed, ', ')) AS g
  WHERE g LIKE '%(Spieler*in)%'
),
team_groups AS (
  -- team_ids is what makes the stray test PER GROUP (2026-08-15) — mirrors
  -- straySql. Several active teams may share one clubdesk_group.
  SELECT (clubdesk_group || ' (Spieler*in)') AS grp, array_agg(id) AS team_ids
  FROM teams WHERE active AND NULLIF(BTRIM(clubdesk_group), '') IS NOT NULL
  GROUP BY clubdesk_group
),
strays AS (
  SELECT m.id, m.uuid,
         BTRIM(COALESCE(m.first_name,'') || ' ' || COALESCE(m.last_name,'')) AS nm,
         cg.grp AS grp
  FROM cd_groups cg
  JOIN team_groups tgr ON tgr.grp = cg.grp
  JOIN members m ON m.clubdesk_id = cg.clubdesk_id
  WHERE m.uuid IS NOT NULL
    -- ⚠⚠ PER GROUP. Was "no roster row this season at all", which made a player
    -- token for a team the member only COACHES invisible whenever they play
    -- somewhere else. A token for team X is stray when there is no roster row
    -- for team X. Mirrors straySql — the two must move together.
    AND NOT EXISTS (SELECT 1 FROM member_teams mt
                     WHERE mt.member = m.id AND mt.team = ANY(tgr.team_ids))
    AND ( EXISTS (SELECT 1 FROM clubdesk_export ce2
                   WHERE BTRIM(ce2.clubdesk_id) = m.clubdesk_id
                     AND ( ce2.status IN ('Kein Mitglied', 'Ehemaliges Mitglied', 'Verstorben')
                           OR COALESCE(BTRIM(ce2.austritt), '') <> '' ))
          OR m.kscw_membership_active = false
          -- ⚠ Scoped to THIS group's teams: staffing HU20 is no licence to strip
          -- a stale D2 player token. Unscoped + per-group would hand every
          -- player-coach's tokens to an UNATTENDED Sunday cron.
          OR EXISTS (SELECT 1 FROM teams_coaches tc WHERE tc.members_id = m.id AND tc.teams_id = ANY(tgr.team_ids))
          OR EXISTS (SELECT 1 FROM teams_responsibles tr WHERE tr.members_id = m.id AND tr.teams_id = ANY(tgr.team_ids)) )
),
stale AS (
  SELECT m.id, m.uuid,
         BTRIM(COALESCE(m.first_name,'') || ' ' || COALESCE(m.last_name,'')) AS nm,
         (t.clubdesk_group || CASE WHEN COALESCE(mt.guest_level,0) > 0
                                   THEN ' (Spieler*in)' ELSE ' (Guest)' END) AS grp
  FROM member_teams mt
  JOIN teams t ON t.id = mt.team AND COALESCE(t.clubdesk_group,'') <> ''
  JOIN members m ON m.id = mt.member
  JOIN clubdesk_export ce ON BTRIM(ce.clubdesk_id) = m.clubdesk_id
  WHERE mt.season = '$SEASON'
    AND m.uuid IS NOT NULL AND m.clubdesk_id IS NOT NULL
    -- the WRONG Funktion is present …
    AND (t.clubdesk_group || CASE WHEN COALESCE(mt.guest_level,0) > 0
                                  THEN ' (Spieler*in)' ELSE ' (Guest)' END)
        = ANY(string_to_array(COALESCE(ce.gruppen_bracketed,''), ', '))
    -- … AND the right one already sits alongside it (never remove the last token)
    AND (t.clubdesk_group || CASE WHEN COALESCE(mt.guest_level,0) > 0
                                  THEN ' (Guest)' ELSE ' (Spieler*in)' END)
        = ANY(string_to_array(COALESCE(ce.gruppen_bracketed,''), ', '))
),
removals AS (
  SELECT id, uuid, nm, grp FROM strays
  UNION
  SELECT id, uuid, nm, grp FROM stale
)"

CNT=$(psqlc "$CTE SELECT count(*) FROM removals" 2>/dev/null || echo -1)
if [ "${CNT:-0}" = "0" ]; then echo "Nothing to remove (0 rows in the auto-remove envelope)."; exit 0; fi
if [ "${CNT:-0}" -lt 0 ]; then echo "ABORT: removal query failed."; exit 1; fi
# Runaway guard 2: cap.
if [ "$CNT" -gt "$CAP" ]; then
  echo "ABORT: $CNT removals exceed CAP=$CAP — refusing to auto-remove (raise CLUBDESK_CLEANUP_CAP to override after review)."
  psqlc "$CTE SELECT nm || '  ✂  ' || grp FROM removals ORDER BY nm" | sed 's/^/  /'
  exit 1
fi

# Build the worklist ([{name,uuid,group_label}]) → file in $DIR (mounted /work).
WL="$DIR/group-cleanup-worklist.json"
cleanup() { rm -f "$WL"; }   # carries uuid + names — don't linger
trap cleanup EXIT
psqlc "$CTE SELECT COALESCE(json_agg(json_build_object('name', nm, 'uuid', uuid, 'group_label', grp)), '[]') FROM removals" > "$WL"
if [ ! -s "$WL" ]; then echo "ABORT: empty worklist."; exit 1; fi
echo "Removal set ($CNT):"
psqlc "$CTE SELECT nm || '  ✂  ' || grp FROM removals ORDER BY nm" | sed 's/^/  /'

# Commit gating: prod + explicit flag → commit; anything else → dry-run preview.
MODE=preview
if [ "$CLUBDESK_ENV" = "prod" ] && [ "${CLUBDESK_CLEANUP_COMMIT:-0}" = "1" ]; then MODE=commit; fi
echo "Mode: $MODE"

SUMMARY=$(flock "$DIR/.sync.lock" docker run --rm -w /work -v "$DIR":/work --env-file "$DIR/.env" "$PW_IMG" \
  node clubdesk-remove-group.mjs "group-cleanup-worklist.json" "$MODE" | tail -1)
echo "Result: $SUMMARY"

# Bring wiedisync's copy of the register in step with what we just removed —
# otherwise /admin/data-health keeps listing these strays (and offering them to the
# "Fix groups" button) until the next sync down re-imports ClubDesk. See
# clubdesk-mirror-patch.sh; commit-only, verified rows only, best effort.
if [ "$MODE" = "commit" ] && [ -n "$SUMMARY" ]; then
  if [ -r "$DIR/clubdesk-mirror-patch.sh" ]; then
    # shellcheck source=/dev/null
    . "$DIR/clubdesk-mirror-patch.sh"
    cd_mirror_patch "$(printf '{"mode":"commit","add":null,"remove":%s}' "$SUMMARY")" | sed 's/^/  /'
  fi
fi
echo "=== group-cleanup done $(TZ=Europe/Zurich date +'%d.%m.%Y %H:%M:%S') ==="
