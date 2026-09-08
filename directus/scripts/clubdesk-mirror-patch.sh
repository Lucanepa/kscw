#!/usr/bin/env bash
# clubdesk-mirror-patch.sh — after a COMMIT, bring wiedisync's copy of the ClubDesk
# register in step with the group allocations we just wrote.
#
# Sourced by clubdesk-group-fix-dispatch.sh (the in-app "Fix groups" button) and
# clubdesk-group-cleanup.sh (the unattended Sunday stray sweep).
#
# WHY THIS EXISTS. Every group finding on /admin/data-health is computed from
# `clubdesk_export.gruppen_bracketed`, i.e. from the last sync DOWN — and a commit
# writes to ClubDesk, not to that table. So a run that did exactly what was asked
# left the page listing the very rows it had just fixed, and the operator ran it
# again, and again (08.09.2026: four BB strays verifiably removed at 14:37, still on
# screen afterwards, because the snapshot was imported at 14:19). Re-running is not
# harmless either — each pass re-drives the whole ClubDesk UI for nothing.
#
# `clubdesk_export` is a MIRROR of the register, and after a verified write we know
# the register better than the snapshot does. Patching it is the write-through half
# of that mirror; the next sync down overwrites the column wholesale, so a wrong
# guess here cannot outlive one import.
#
#   cd_mirror_patch '<result json>'   {"mode":…, "add":<summary|null>, "remove":<summary|null>}
#
# The caller must already define `psqlc` (both dispatchers do) and must call this
# ONLY for a run whose effective mode is commit — a preview writes nothing, so
# patching after one would invent register state out of thin air.
#
# ⚠ ONLY VERIFIED-SUCCESS ROWS. `removed` is trustworthy: clubdesk-remove-group.mjs
# re-reads the chip and re-asserts the contact's Wiedisync ID before it saves, and
# aborts without saving otherwise. `assigned` is weaker — it means ClubDesk accepted
# the dialog's OK, with no read-back — so a silently-failed add stays hidden until
# the next sync down re-imports the truth. Every other status (skip_*, error,
# previewed) is left alone on purpose: those rows SHOULD keep showing up.
#
# ⚠ BEST EFFORT. The job's own state and result are already written by the time this
# runs; a mirror that could not be patched is a stale page, not a failed run, so
# nothing here is allowed to abort the caller.

# Strip the tokens the remove tool actually removed.
_cdmp_removals() {
  psqlc "
WITH d AS (SELECT \$cdmp\$${1}\$cdmp\$::jsonb AS j),
rem AS (
  SELECT x->>'uuid' AS uuid, BTRIM(x->>'group_label') AS grp
    FROM d, LATERAL jsonb_array_elements(COALESCE(d.j->'remove'->'results', '[]'::jsonb)) AS x
   WHERE x->>'status' = 'removed'
     AND COALESCE(BTRIM(x->>'uuid'), '') <> ''
     AND COALESCE(BTRIM(x->>'group_label'), '') <> ''
),
tgt AS (
  -- Per export ROW, not per member: one contact can lose two tokens in a run, and
  -- UPDATE … FROM would then apply only one of them.
  SELECT ce.row_id, array_agg(DISTINCT rem.grp) AS grps
    FROM rem
    JOIN members m ON m.uuid::text = rem.uuid
    JOIN clubdesk_export ce ON BTRIM(ce.clubdesk_id) = m.clubdesk_id
   GROUP BY ce.row_id
)
UPDATE clubdesk_export ce
   SET gruppen_bracketed = COALESCE((
         SELECT string_agg(BTRIM(u.g), ', ' ORDER BY u.ord)
           FROM unnest(string_to_array(COALESCE(ce.gruppen_bracketed, ''), ', ')) WITH ORDINALITY AS u(g, ord)
          WHERE BTRIM(u.g) <> '' AND BTRIM(u.g) <> ALL (tgt.grps)
       ), '')
  FROM tgt
 WHERE ce.row_id = tgt.row_id"
}

# Append the tokens the add tool reported as written, in the same '<group> (<funktion>)'
# shape the export uses. Official groups carry no funktion, hence the CASE.
_cdmp_additions() {
  psqlc "
WITH d AS (SELECT \$cdmp\$${1}\$cdmp\$::jsonb AS j),
adds AS (
  SELECT BTRIM(x->>'clubdesk_id') AS cdid,
         BTRIM(x->>'group') || CASE WHEN COALESCE(BTRIM(x->>'funktion'), '') <> ''
                                    THEN ' (' || BTRIM(x->>'funktion') || ')' ELSE '' END AS grp
    FROM d, LATERAL jsonb_array_elements(COALESCE(d.j->'add'->'results', '[]'::jsonb)) AS x
   WHERE x->>'status' = 'assigned'
     AND COALESCE(BTRIM(x->>'clubdesk_id'), '') <> ''
     AND COALESCE(BTRIM(x->>'group'), '') <> ''
),
tgt AS (
  SELECT ce.row_id, array_agg(DISTINCT a.grp) AS grps
    FROM adds a
    JOIN clubdesk_export ce ON BTRIM(ce.clubdesk_id) = a.cdid
   GROUP BY ce.row_id
)
UPDATE clubdesk_export ce
   SET gruppen_bracketed = (
         SELECT string_agg(s.g, ', ' ORDER BY s.ord)
           FROM (
             SELECT BTRIM(u.g) AS g, u.ord AS ord
               FROM unnest(string_to_array(COALESCE(ce.gruppen_bracketed, ''), ', ')) WITH ORDINALITY AS u(g, ord)
              WHERE BTRIM(u.g) <> ''
             UNION ALL
             -- New tokens go last; a token already on the row is not duplicated.
             SELECT n.g, 1000000 + n.ord
               FROM unnest(tgt.grps) WITH ORDINALITY AS n(g, ord)
              WHERE NOT (n.g = ANY (SELECT BTRIM(u2.g)
                                      FROM unnest(string_to_array(COALESCE(ce.gruppen_bracketed, ''), ', ')) AS u2(g)))
           ) s
       )
  FROM tgt
 WHERE ce.row_id = tgt.row_id"
}

cd_mirror_patch() {
  local json="${1:-}"
  case "$json" in ''|null) return 0 ;; esac
  local r a
  r=$(_cdmp_removals "$json" 2>&1) || r="mirror patch (removals) failed: $r"
  a=$(_cdmp_additions "$json" 2>&1) || a="mirror patch (additions) failed: $a"
  echo "mirror: removals → ${r:-none}"
  echo "mirror: additions → ${a:-none}"
  return 0
}
