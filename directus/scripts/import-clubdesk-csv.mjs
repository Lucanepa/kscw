#!/usr/bin/env node
/**
 * import-clubdesk-csv.mjs — Load a ClubDesk member export into the
 * `clubdesk_export` staging table (migrations 064 + 065).
 *
 * Usage:
 *   node directus/scripts/import-clubdesk-csv.mjs <env> <csv-path>
 *
 *   <env>      ∈ { dev, prod }
 *   <csv-path> — path on local machine. CP1252-encoded, semicolon-delimited.
 *
 * Handles both ClubDesk export shapes:
 *   1. Section-filtered (Sektion=Volleyball etc.) — 60 cols, Gruppe + Funktion
 *      duplicated as leading iterator keys AND trailing detail columns.
 *   2. Full-club export — 58 cols, no duplicates, includes [Gruppen] and
 *      [Rolle] bracketed system columns.
 *
 * The script is HEADER-NAME-aware:
 *   - Reads the first row, maps each source column name to a known target
 *     column (with `_2` suffix for repeated names).
 *   - Reorders each data row to match the target table's column order.
 *   - Unmapped headers are dropped with a warning; missing target columns
 *     are filled with NULL.
 *
 * No npm deps — only node:child_process / node:fs / built-in TextDecoder.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const ENVS = {
  dev:  { container: 'kscw-postgres', database: 'directus_kscw_dev', user: 'supabase_admin' },
  prod: { container: 'kscw-postgres', database: 'postgres',          user: 'supabase_admin' },
}

const rawArgs = process.argv.slice(2)
// --local (or CLUBDESK_IMPORT_LOCAL=1): run `docker exec` directly instead of
// hopping through `ssh hetzner` — used when this runs ON the VPS (e.g. cron).
const LOCAL = process.env.CLUBDESK_IMPORT_LOCAL === '1' || rawArgs.includes('--local')
// --emit-sql: print the psql script to stdout instead of running it, so a caller
// that can't reach the DB (e.g. the scrape running in a container) can pipe it
// into the pg container itself. Progress logs go to stderr to keep stdout clean.
const EMIT_SQL = rawArgs.includes('--emit-sql')
const [envName, csvPath] = rawArgs.filter((a) => !a.startsWith('--'))
if (!envName || !ENVS[envName] || !csvPath) {
  console.error('Usage: import-clubdesk-csv.mjs <dev|prod> <csv-path> [--local]')
  process.exit(1)
}
const env = ENVS[envName]

// ── Header-name → table-column map ─────────────────────────────────
// Keys are CSV header strings (with `_2` suffix appended by the
// dedup step for repeated headers). Values are clubdesk_export column
// names from migration 064 + 065.
const HEADER_TO_COL = {
  // Standard columns
  'Gruppe': 'gruppe',                                   'Funktion': 'funktion',
  'Nachname': 'nachname',                               'Vorname': 'vorname',
  'Firma': 'firma',                                     'Rolle': 'rolle',
  'Anrede': 'anrede',                                   'Titel': 'titel',
  'Briefanrede': 'briefanrede',                         'Benutzer-Id': 'benutzer_id',
  'Adresse': 'adresse',                                 'Adress-Zusatz': 'adress_zusatz',
  'PLZ': 'plz',                                         'Ort': 'ort',
  'Land': 'land',                                       'Nationalität': 'nationalitaet',
  'Telefon Privat': 'telefon_privat',                   'Telefon Geschäft': 'telefon_geschaeft',
  'Telefon Mobil': 'telefon_mobil',                     'Fax': 'fax',
  'E-Mail': 'email',                                    'E-Mail Alternativ': 'email_alternativ',
  'Gruppen': 'gruppen',                                 'Status': 'status',
  'Eintritt': 'eintritt',                               'Mitgliedsjahre': 'mitgliedsjahre',
  'Austritt': 'austritt',                               'Zivilstand': 'zivilstand',
  'Geschlecht': 'geschlecht',                           'Geburtsdatum': 'geburtsdatum',
  'Alter': 'alter_',                                    'Jahrgang': 'jahrgang',
  'Bemerkungen': 'bemerkungen',                         'Firmen-Webseite': 'firmen_webseite',
  'Rechnungsversand': 'rechnungsversand',               'Nie mahnen': 'nie_mahnen',
  'IBAN': 'iban',                                       'BIC': 'bic',
  'Kontoinhaber': 'kontoinhaber',                       'Lizenznummer': 'lizenznummer',
  'Lizenzart': 'lizenzart',                             'Lizenz bestellt': 'lizenz_bestellt',
  'Sektion': 'sektion',                                 'Beitragskategorie': 'beitragskategorie',
  'Betrag Bezahlt': 'betrag_bezahlt',                   'Clubnummer': 'clubnummer',
  'Mittelschule ZH': 'mittelschule_zh',                 'Offiziellen Lizenz': 'offiziellen_lizenz',
  'Mitgliederbeitrag': 'mitgliederbeitrag',             'AHV Nummer': 'ahv_nummer',
  'Passivmitglied': 'passivmitglied',                   'Offiziellen 100er': 'offiziellen_100er',
  'Jg.': 'jg',                                          '[Id]': 'clubdesk_id',
  'Wiedisync ID': 'wiedisync_id',                       // custom field: wiedisync's own member id (push round-trip key)
  // J+S Personennummer (SALTO). Down-sync only (fill-only into members.js_id).
  // Column header in ClubDesk is "JS ID" (created 2026-07-08).
  'JS ID': 'js_id',
  // Federation of origin — the national federation the member was last licensed
  // with (Swiss Volley transfer certificate / FIBA letter of clearance). Custom
  // ClubDesk picklist created 2026-07-25, holding the GERMAN country name (or
  // "Keiner"); wiedisync owns the field and stores an ISO alpha-2 code / 'NONE'
  // (migration 223), so the down-sync pass below parses the string back into a
  // code and only ever FILLS an unanswered member row.
  'Federation of Origin': 'federation_of_origin',
  // Trainer Lizenz — coaching education (J+S and/or the C/B/A ladder). Custom
  // ClubDesk field created 2026-08-03 as **free text** (not the Auswahl it
  // started as) precisely so the multi-value form fits: wiedisync stores a SET
  // (migration 274) and a single-select cell would force a lossy collapse.
  // Two-way: wiedisync owns it (members declare it in their profile) and pushes
  // ClubDesk's wording via trainerLicenceCell, while the pass below parses the
  // register's text back into codes and only ever FILLS a member who never
  // answered — same rule as ahv_nummer / anrede.
  'Trainer Lizenz': 'trainer_lizenz',
  // Gast — ClubDesk Ja/Nein checkbox created 2026-07-27, filled ONLY by
  // wiedisync's push (the roster in `member_teams.guest_level` is the sole
  // source; see CD_PUSH_CONTACT_HEADERS in clubdesk-update.js). Staged here
  // purely so computeClubdeskDrift can compare the register against the current
  // roster and re-flag a member whose guest status changed. ⚠ Deliberately NO
  // write-back pass into `members` below: wiedisync owns this field outright,
  // so letting ClubDesk's copy flow back would let a stale register overwrite
  // the live roster.
  'Gast': 'gast',
  '[Zuletzt geändert am]': 'zuletzt_geaendert_am',      '[Zuletzt geändert von]': 'zuletzt_geaendert_von',
  // Bracketed system variants (full-club export only — migration 065)
  '[Gruppen]': 'gruppen_bracketed',                     '[Rolle]': 'rolle_bracketed',
  // Duplicate headers (section-filtered export adds trailing detail cols)
  'Gruppe_2': 'gruppe_2',                               'Funktion_2': 'funktion_2',
  'Gruppen_2': 'gruppen_2',                             'Rolle_2': 'rolle_2',
}

// Target column order (must match \copy column list below)
const TARGET_COLS = [
  'gruppe','funktion','nachname','vorname','firma',
  'rolle','rolle_2','anrede','titel','briefanrede',
  'benutzer_id','adresse','adress_zusatz','plz','ort',
  'land','nationalitaet','telefon_privat','telefon_geschaeft','telefon_mobil',
  'fax','email','email_alternativ','gruppen','status',
  'eintritt','mitgliedsjahre','austritt','zivilstand','geschlecht',
  'geburtsdatum','alter_','jahrgang','bemerkungen','firmen_webseite',
  'rechnungsversand','nie_mahnen','iban','bic','kontoinhaber',
  'lizenznummer','lizenzart','lizenz_bestellt','sektion','beitragskategorie',
  'betrag_bezahlt','clubnummer','mittelschule_zh','offiziellen_lizenz','mitgliederbeitrag',
  'ahv_nummer','passivmitglied','offiziellen_100er','gruppe_2','funktion_2',
  'gruppen_2','jg','clubdesk_id','zuletzt_geaendert_am','zuletzt_geaendert_von',
  'gruppen_bracketed','rolle_bracketed','wiedisync_id','js_id','federation_of_origin',
  'gast','trainer_lizenz',
]

// ── 1. Decode CSV (CP1252 → UTF-8) ──────────────────────────────────
const text = new TextDecoder('windows-1252').decode(readFileSync(csvPath))

// ── 2. Parse CSV (state machine; handles quoted fields w/ embedded newlines) ─
function parseCsv(s, delim = ';') {
  const rows = []
  let row = [], field = '', inQ = false, i = 0
  while (i < s.length) {
    const c = s[i]
    if (inQ) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i += 2 }
      else if (c === '"') { inQ = false; i++ }
      else { field += c; i++ }
    } else {
      if (c === '"' && field === '') { inQ = true; i++ }
      else if (c === delim) { row.push(field); field = ''; i++ }
      else if (c === '\r') { i++ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++ }
      else { field += c; i++ }
    }
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

const allRows = parseCsv(text)
if (allRows.length < 2) {
  console.error('CSV has fewer than 2 rows — empty or unreadable.')
  process.exit(1)
}
const headerRaw = allRows[0]
const dataRows = allRows.slice(1).filter(r => r.some(c => c && c.length))

// ── 3. Build header → target-column index map (dedup repeated names) ─
const seen = new Map()
const sourceColNames = headerRaw.map(h => {
  const n = (seen.get(h) || 0) + 1
  seen.set(h, n)
  return n === 1 ? h : `${h}_${n}`
})
const sourceIxToTarget = sourceColNames.map(name => HEADER_TO_COL[name] || null)
const unmapped = sourceColNames.filter(n => !HEADER_TO_COL[n])
if (unmapped.length) {
  console.warn(`⚠ Unmapped CSV headers (dropped): ${unmapped.join(', ')}`)
}

// targetCol -> source index (for fast row reorder)
const targetToSourceIx = {}
sourceIxToTarget.forEach((tc, srcIx) => { if (tc) targetToSourceIx[tc] = srcIx })

// ── 4. Emit CSV in target column order ──────────────────────────────
const csvEscape = (s) => {
  if (s == null || s === '') return ''
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const outLines = dataRows.map(row =>
  TARGET_COLS.map(tc => {
    const srcIx = targetToSourceIx[tc]
    return srcIx == null ? '' : csvEscape(row[srcIx] || '')
  }).join(';')
)

// ── 5. Send to psql via SSH ─────────────────────────────────────────
const fileTag = basename(csvPath).replace(/'/g, "''")
const psqlInput =
  'BEGIN;\n' +
  'TRUNCATE clubdesk_export RESTART IDENTITY;\n' +
  `\\copy clubdesk_export(${TARGET_COLS.join(', ')}) FROM STDIN WITH (FORMAT csv, DELIMITER ';', QUOTE '"', NULL '');\n` +
  outLines.join('\n') + '\n' +
  '\\.\n' +
  `UPDATE clubdesk_export_meta SET last_import_at = NOW(), source_file = '${fileTag}', row_count = (SELECT COUNT(*) FROM clubdesk_export) WHERE id = 1;\n` +
  'COMMIT;\n' +
  "SELECT 'rows', (SELECT COUNT(*) FROM clubdesk_export), 'volleyball', (SELECT COUNT(*) FROM clubdesk_volleyball), 'last_import', (SELECT last_import_at FROM clubdesk_export_meta WHERE id=1);\n" +
  // ── COLLAPSED 2026-08-14 (migration 321) ────────────────────────────────────
  // Two passes used to live here: birthdate-by-licence/email, and contact-fields-
  // by-licence/email. Both ran BEFORE the clubdesk_id linker below, which is the
  // only reason they existed — they matched on licence/email because there was no
  // link yet to match on.
  //
  // ⚠⚠ They are gone rather than converted, and that is the point. Because they
  // ran first and carried NO `clubdesk_push_pending` guard, they wrote 7 columns
  // (birthdate, adresse, plz, ort, phone, beitragskategorie, sektion) that the
  // guarded register pass further down believed it was protecting: by the time it
  // ran, its own change-detection WHERE found nothing left to change. So the guard
  // that was supposed to stop the sync reverting a wiedisync edit only ever worked
  // for members these two passes failed to match. That is the defect migration 319
  // had to fix forward for `beitragskategorie`, one column at a time.
  //
  // Everything they did is now covered by the single detection pass below, keyed
  // on clubdesk_id alone (709 of 711 members are linked; the linker runs first and
  // the handful it links in THIS run are detected in the same run, exactly as
  // before). No behaviour is lost — only the unguarded write path is.
  // ── Link members.clubdesk_id from staging (the sync-up "is this contact already
  // in ClubDesk?" key) ────────────────────────────────────────────────────────
  // Migration 158 did this once, but only matched email + a ONE-directional first-
  // name prefix (member-name LIKE clubdesk-name||'%'), so a member stored under a
  // short form ("Alex") never linked to the full ClubDesk name ("Alexander") even
  // with an identical email AND licence — leaving them falsely listed as "not yet
  // in ClubDesk" and at risk of being DUPLICATED on sync-up. Re-link on every sync,
  // NULL-only (never clobber a manual/existing link): (1) licence (1:1, authoritative,
  // no name needed); (2) email(+alt) + last-name equality + SYMMETRIC first-name
  // prefix (handles Alex↔Alexander, Nico↔Nicolas, Sharu↔Sharusanth). last-name
  // equality guards a shared family email from cross-linking parent↔child. Only
  // unambiguous matches (one distinct clubdesk_id) are applied. Own transaction.
  //
  // REVERSE-uniqueness guard: HAVING count(DISTINCT cd.cdid)=1 only stops ONE member
  // matching MANY contacts. It does NOT stop MANY members matching ONE contact — two
  // family members sharing an email/similar name would otherwise be assigned the SAME
  // clubdesk_id, corrupting departed-detection (both deactivated when one leaves) and
  // sync-up. So each pass also filters to cdids that map to exactly ONE candidate
  // member AND are not already held by another member (NOT EXISTS). A cdid claimed by
  // >1 member is SKIPPED and reported below ('clubdesk_link_ambiguous') for a human to
  // link manually. These app-level guards are now belt-and-braces on top of the
  // partial unique index members_clubdesk_id_uq (migration 170): a dup assignment that
  // slips past them aborts THIS linker's own transaction loudly (surfaces in the sync
  // log) rather than silently corrupting — so don't "simplify away" the CTEs.
  'BEGIN;\n' +
  // ── Wiedisync ID link (2026-07-07) — the AUTHORITATIVE key, runs FIRST ──────
  // wiedisync pushes its member UUID (members.uuid, migration 184; pre-184
  // pushes carried the numeric members.id) into the ClubDesk "Wiedisync ID"
  // custom field on every create+update; here we read it straight back and link
  // by an EXACT key match — immune to the name/email/accent drift the heuristic
  // passes below suffer (it is what closes the create round-trip
  // up→[Id]→down-link). Both key formats stay accepted forever: UUID → uuid,
  // digits → id. Same unambiguity + not-already-held guards as the other
  // passes; the partial unique index members_clubdesk_id_uq is the final
  // backstop.
  'WITH cd AS (\n' +
  "  SELECT btrim(clubdesk_id) cdid, lower(btrim(wiedisync_id)) wid FROM clubdesk_export\n" +
  "  WHERE NULLIF(btrim(clubdesk_id),'') IS NOT NULL\n" +
  "    AND (btrim(wiedisync_id) ~ '^[0-9]+$'\n" +
  "         OR btrim(wiedisync_id) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),\n" +
  'wid_match AS (\n' +
  '  SELECT mm.id, min(cd.cdid) cdid FROM members mm\n' +
  '  JOIN cd ON cd.wid = CASE WHEN cd.wid ~ \'^[0-9]+$\' THEN mm.id::text ELSE mm.uuid::text END\n' +
  '  WHERE mm.clubdesk_id IS NULL\n' +
  '  GROUP BY mm.id HAVING count(DISTINCT cd.cdid) = 1),\n' +
  'wid_uniq AS (SELECT cdid FROM wid_match GROUP BY cdid HAVING count(*) = 1)\n' +
  'UPDATE members m SET clubdesk_id = wid_match.cdid\n' +
  '  FROM wid_match JOIN wid_uniq USING (cdid)\n' +
  '  WHERE m.id = wid_match.id AND m.clubdesk_id IS NULL\n' +
  '    AND NOT EXISTS (SELECT 1 FROM members x WHERE x.clubdesk_id = wid_match.cdid);\n' +
  'WITH cd AS (\n' +
  '  SELECT btrim(clubdesk_id) cdid, lower(btrim(email)) email, lower(btrim(email_alternativ)) email_alt,\n' +
  "         lower(btrim(lizenznummer)) lic, lower(btrim(nachname)) nachname,\n" +
  "         lower(split_part(btrim(vorname),' ',1)) vn1\n" +
  "  FROM clubdesk_export WHERE NULLIF(btrim(clubdesk_id),'') IS NOT NULL),\n" +
  'lic_match AS (\n' +
  '  SELECT mm.id, min(cd.cdid) cdid FROM members mm\n' +
  "  JOIN cd ON cd.lic <> '' AND cd.lic = lower(btrim(mm.license_nr))\n" +
  "  WHERE mm.clubdesk_id IS NULL AND NULLIF(btrim(mm.license_nr),'') IS NOT NULL\n" +
  '  GROUP BY mm.id HAVING count(DISTINCT cd.cdid) = 1),\n' +
  'lic_uniq AS (SELECT cdid FROM lic_match GROUP BY cdid HAVING count(*) = 1)\n' +
  'UPDATE members m SET clubdesk_id = lic_match.cdid\n' +
  '  FROM lic_match JOIN lic_uniq USING (cdid)\n' +
  '  WHERE m.id = lic_match.id AND m.clubdesk_id IS NULL\n' +
  '    AND NOT EXISTS (SELECT 1 FROM members x WHERE x.clubdesk_id = lic_match.cdid);\n' +
  // ACCENT-INSENSITIVE name match (2026-07-07): compare unaccent()ed names on
  // both sides. Our sync-UP transliterates letters CP1252 can't hold (ć→c, ń→n,
  // ł→l — toCp1252Buffer), so a just-created contact is stored in ClubDesk with
  // an ASCII name while wiedisync keeps the accented original. An EXACT last-name
  // match then never links it → the member is stranded "pushed, awaiting link"
  // forever (the Kacper Krawczyński/Krawczynski case). unaccent() normalises both
  // sides identically (verified: Krawczyński→Krawczynski, Curavić→Curavic,
  // łódź→lodz), so the create round-trip (up → new [Id] → down-link) closes even
  // for accented names. email + first-name still constrain, so no family mislink.
  'WITH cd AS (\n' +
  '  SELECT btrim(clubdesk_id) cdid, lower(btrim(email)) email, lower(btrim(email_alternativ)) email_alt,\n' +
  "         unaccent(lower(btrim(nachname))) nachname, unaccent(lower(split_part(btrim(vorname),' ',1))) vn1\n" +
  "  FROM clubdesk_export WHERE NULLIF(btrim(clubdesk_id),'') IS NOT NULL),\n" +
  'email_match AS (\n' +
  '  SELECT mm.id, min(cd.cdid) cdid FROM members mm\n' +
  "  JOIN cd ON NULLIF(btrim(mm.email),'') IS NOT NULL AND lower(btrim(mm.email)) IN (cd.email, cd.email_alt)\n" +
  '       AND unaccent(lower(btrim(mm.last_name))) = cd.nachname\n' +
  // Blank-first-name guard (audit #15): a member with an empty first_name makes
  // split_part('',' ',1)='' → `cd.vn1 LIKE '%'` = TRUE for every contact, so the
  // first-name guard collapses to match-all. Require both sides non-empty.
  "       AND NULLIF(split_part(btrim(mm.first_name),' ',1),'') IS NOT NULL AND NULLIF(cd.vn1,'') IS NOT NULL\n" +
  "       AND (unaccent(lower(split_part(btrim(mm.first_name),' ',1))) LIKE cd.vn1 || '%'\n" +
  "            OR cd.vn1 LIKE unaccent(lower(split_part(btrim(mm.first_name),' ',1))) || '%')\n" +
  '  WHERE mm.clubdesk_id IS NULL\n' +
  '  GROUP BY mm.id HAVING count(DISTINCT cd.cdid) = 1),\n' +
  'email_uniq AS (SELECT cdid FROM email_match GROUP BY cdid HAVING count(*) = 1)\n' +
  'UPDATE members m SET clubdesk_id = email_match.cdid\n' +
  '  FROM email_match JOIN email_uniq USING (cdid)\n' +
  '  WHERE m.id = email_match.id AND m.clubdesk_id IS NULL\n' +
  '    AND NOT EXISTS (SELECT 1 FROM members x WHERE x.clubdesk_id = email_match.cdid);\n' +
  'COMMIT;\n' +
  "SELECT 'members_linked_clubdesk' AS metric, (SELECT count(*) FROM members WHERE clubdesk_id IS NOT NULL) AS value;\n" +
  // ── Create members for ClubDesk contacts with no Directus row (user 2026-07-07) ──
  // Every pass in this script UPDATEs existing members rows — a ClubDesk contact
  // with no members row was silently never created. That is why the ~167 Passiv-/
  // Ehrenmitglieder (and any future direct-in-ClubDesk signup) were missing from
  // Directus and from every member count derived from it. Create them here:
  // AFTER the linker (a contact that just linked to an existing member must not
  // be re-created) and BEFORE the sex/identity/contact passes (fresh rows get
  // enriched in this same run). Scope: CURRENT members only — Status ∈ Aktiv/
  // Passiv/Ehren/Zwischenjahr and no Austritt; 'Kein Mitglied' contacts
  // (companies, parents, suppliers) and departed members stay out of members.
  // clubdesk_id is set IN the insert: a row with clubdesk_id populated can never
  // enter the sync-up CREATE set (clubdesk-update.js builds creates from
  // whereNull('clubdesk_id')), so this pass cannot cause duplicate contacts in
  // ClubDesk. SAME-PERSON GUARDS: ClubDesk itself carries duplicate contacts for
  // one person (old exited twin + re-registered twin, married-name changes,
  // first/middle-name order swaps — 18 such found in the 2026-07-07 rehearsal,
  // sometimes with the members row linked to the STALE twin). A contact whose
  // cdid is unclaimed may therefore still BE an already-represented person, so
  // creation is skipped when ANY existing member (linked or not — unlinked also
  // covers fresh wiedisync registrations the linker couldn't link yet) matches:
  //   G1 same email + symmetric first-name prefix   (catches married-name change)
  //   G2 same last name + symmetric first-name prefix (catches re-registrations)
  //   G3 same email + same last name                  (catches name-order swaps)
  // G1/G3 match the member email against BOTH staged emails (email +
  // email_alternativ), like the linker — a married-name change whose old email
  // survives only in E-Mail Alternativ would otherwise slip all three guards.
  // The symmetric-prefix rule is the linker's own. G3 deliberately has no
  // first-name condition: it also skips a family member sharing the household
  // email AND last name (1 known case) — skipping + reporting a real person is
  // recoverable (add by hand), creating a duplicate person silently is not.
  // G4 (within-batch): the members-based guards can't see sibling rows of the
  // same INSERT…SELECT, so two same-person twin contacts that are BOTH absent
  // from Directus would both insert. A fresh row is dropped when another
  // CURRENT contact with a lower [Id] (numeric-safe (length,value) text order)
  // matches it on the same G1/G2/G3 rules — the older twin wins, the loser
  // stays unclaimed and surfaces in the suspected-duplicate report (it matches
  // the winner's member row from this run onward).
  // Skipped contacts are reported below (clubdesk_contact_suspected_duplicate)
  // for a human to merge in ClubDesk or add manually. Everything else rides on
  // DB defaults (kscw_membership_active true, website_visible false,
  // wiedisync_active false, consent_decision 'pending'); no Directus hook/flow
  // fires on this raw-SQL channel. email falls back to '' when ClubDesk has none
  // (a handful of passive contacts): NOT NULL allows it and
  // trg_members_prevent_email_blanking only guards UPDATEs.
  'BEGIN;\n' +
  'WITH cd AS (\n' +
  '  SELECT DISTINCT ON (btrim(clubdesk_id)) btrim(clubdesk_id) AS cdid,\n' +
  "         left(btrim(vorname),255) AS first_name, left(btrim(nachname),255) AS last_name,\n" +
  // Stored lowercased — the canonical email shape (migration 186 backfilled the
  // stock; match keys below were always lowercased).
  "         lower(left(btrim(email),255)) AS email,\n" +
  "         lower(btrim(email)) AS email_l, lower(btrim(email_alternativ)) AS email_alt_l,\n" +
  "         lower(btrim(nachname)) AS nachname_l,\n" +
  "         lower(split_part(btrim(vorname),' ',1)) AS vn1\n" +
  '  FROM clubdesk_export\n' +
  "  WHERE NULLIF(btrim(clubdesk_id),'') IS NOT NULL AND length(btrim(clubdesk_id)) <= 64\n" +
  "    AND NULLIF(btrim(austritt),'') IS NULL\n" +
  "    AND btrim(status) IN ('Aktivmitglied','Passivmitglied','Ehrenmitglied','Zwischenjahr')\n" +
  '  ORDER BY btrim(clubdesk_id), row_id DESC),\n' +
  'fresh AS (\n' +
  '  SELECT cd.* FROM cd\n' +
  '  WHERE NOT EXISTS (SELECT 1 FROM members m WHERE btrim(m.clubdesk_id) = cd.cdid)\n' +
  '    AND NOT EXISTS (SELECT 1 FROM members m WHERE\n' +
  "          NULLIF(btrim(m.email),'') IS NOT NULL AND lower(btrim(m.email)) IN (cd.email_l, cd.email_alt_l)\n" +
  "          AND NULLIF(split_part(btrim(m.first_name),' ',1),'') IS NOT NULL AND NULLIF(cd.vn1,'') IS NOT NULL\n" +
  "          AND (lower(split_part(btrim(m.first_name),' ',1)) LIKE cd.vn1 || '%'\n" +
  "               OR cd.vn1 LIKE lower(split_part(btrim(m.first_name),' ',1)) || '%'))\n" +
  '    AND NOT EXISTS (SELECT 1 FROM members m WHERE\n' +
  '          lower(btrim(m.last_name)) = cd.nachname_l\n' +
  "          AND NULLIF(split_part(btrim(m.first_name),' ',1),'') IS NOT NULL AND NULLIF(cd.vn1,'') IS NOT NULL\n" +
  "          AND (lower(split_part(btrim(m.first_name),' ',1)) LIKE cd.vn1 || '%'\n" +
  "               OR cd.vn1 LIKE lower(split_part(btrim(m.first_name),' ',1)) || '%'))\n" +
  '    AND NOT EXISTS (SELECT 1 FROM members m WHERE\n' +
  "          NULLIF(btrim(m.email),'') IS NOT NULL AND lower(btrim(m.email)) IN (cd.email_l, cd.email_alt_l)\n" +
  '          AND lower(btrim(m.last_name)) = cd.nachname_l)\n' +
  '    AND NOT EXISTS (SELECT 1 FROM cd c2 WHERE\n' +
  '          (length(c2.cdid), c2.cdid) < (length(cd.cdid), cd.cdid)\n' +
  "          AND (((NULLIF(cd.email_l,'') IS NOT NULL AND cd.email_l IN (c2.email_l, c2.email_alt_l))\n" +
  "                OR (NULLIF(cd.email_alt_l,'') IS NOT NULL AND cd.email_alt_l IN (c2.email_l, c2.email_alt_l)))\n" +
  '               AND (c2.nachname_l = cd.nachname_l\n' +
  "                    OR (NULLIF(c2.vn1,'') IS NOT NULL AND NULLIF(cd.vn1,'') IS NOT NULL\n" +
  "                        AND (c2.vn1 LIKE cd.vn1 || '%' OR cd.vn1 LIKE c2.vn1 || '%')))\n" +
  '            OR (c2.nachname_l = cd.nachname_l\n' +
  "                AND NULLIF(c2.vn1,'') IS NOT NULL AND NULLIF(cd.vn1,'') IS NOT NULL\n" +
  "                AND (c2.vn1 LIKE cd.vn1 || '%' OR cd.vn1 LIKE c2.vn1 || '%'))))),\n" +
  // ⚠⚠ 2026-08-14 (migration 321): this no longer INSERTs a member. It stages a
  // `create` proposal and a superadmin decides. Everything above — the scope
  // filter and the four same-person guards — is unchanged and still does the hard
  // part: it is what stops the queue filling with 447 departed contacts and with
  // people who already have a row under a married/re-registered name. The review
  // step is for the residue those guards cannot judge.
  //
  // The contact's name + email ride along in `payload` because clubdesk_export is
  // TRUNCATEd and reloaded on every run: by the time somebody opens the queue, the
  // row that produced this proposal may describe a different export. A create
  // proposal has to carry its own evidence.
  //
  // ON CONFLICT DO NOTHING covers a re-run (the partial unique on clubdesk_id WHERE
  // pending); the NOT EXISTS covers a REFUSED one, which is a different index and
  // would otherwise be re-proposed every single run — a refusal has to stick.
  'ins AS (\n' +
  '  INSERT INTO clubdesk_sync_proposals (member_id, clubdesk_id, field, current_value, proposed_value, rule, payload)\n' +
  "  SELECT NULL, cdid, NULL, NULL, first_name || ' ' || last_name, 'create',\n" +
  "         jsonb_build_object('first_name', first_name, 'last_name', last_name, 'email', COALESCE(email,''))\n" +
  '  FROM fresh\n' +
  '  WHERE NOT EXISTS (SELECT 1 FROM clubdesk_sync_proposals p\n' +
  "                     WHERE p.rule = 'create' AND p.status = 'refused' AND p.clubdesk_id = fresh.cdid)\n" +
  '  ON CONFLICT DO NOTHING\n' +
  '  RETURNING 1)\n' +
  "SELECT 'clubdesk_create_proposals' AS metric, count(*) AS value FROM ins;\n" +
  'COMMIT;\n' +
  // Report the contacts the same-person guards skipped (current members whose
  // cdid stayed unclaimed): each is either a ClubDesk duplicate contact to MERGE
  // in ClubDesk, or (rarely) a real second person sharing the household email +
  // last name — add that one manually. Mirrors clubdesk_link_ambiguous below.
  'WITH cd AS (\n' +
  '  SELECT DISTINCT ON (btrim(clubdesk_id)) btrim(clubdesk_id) AS cdid,\n' +
  '         btrim(vorname) AS vorname, btrim(nachname) AS nachname,\n' +
  "         lower(btrim(email)) AS email_l, lower(btrim(email_alternativ)) AS email_alt_l,\n" +
  "         lower(btrim(nachname)) AS nachname_l,\n" +
  "         lower(split_part(btrim(vorname),' ',1)) AS vn1\n" +
  '  FROM clubdesk_export\n' +
  "  WHERE NULLIF(btrim(clubdesk_id),'') IS NOT NULL AND length(btrim(clubdesk_id)) <= 64\n" +
  "    AND NULLIF(btrim(austritt),'') IS NULL\n" +
  "    AND btrim(status) IN ('Aktivmitglied','Passivmitglied','Ehrenmitglied','Zwischenjahr')\n" +
  '  ORDER BY btrim(clubdesk_id), row_id DESC)\n' +
  "SELECT 'clubdesk_contact_suspected_duplicate' AS metric, cd.cdid,\n" +
  "       cd.vorname || ' ' || cd.nachname AS contact,\n" +
  "       string_agg(DISTINCT m.id::text, ',' ORDER BY m.id::text) AS member_ids\n" +
  '  FROM cd JOIN members m ON (\n' +
  "       (NULLIF(btrim(m.email),'') IS NOT NULL AND lower(btrim(m.email)) IN (cd.email_l, cd.email_alt_l)\n" +
  '        AND lower(btrim(m.last_name)) = cd.nachname_l)\n' +
  "    OR ((NULLIF(btrim(m.email),'') IS NOT NULL AND lower(btrim(m.email)) IN (cd.email_l, cd.email_alt_l)\n" +
  '         OR lower(btrim(m.last_name)) = cd.nachname_l)\n' +
  "        AND NULLIF(split_part(btrim(m.first_name),' ',1),'') IS NOT NULL AND NULLIF(cd.vn1,'') IS NOT NULL\n" +
  "        AND (lower(split_part(btrim(m.first_name),' ',1)) LIKE cd.vn1 || '%'\n" +
  "             OR cd.vn1 LIKE lower(split_part(btrim(m.first_name),' ',1)) || '%')))\n" +
  '  WHERE NOT EXISTS (SELECT 1 FROM members x WHERE btrim(x.clubdesk_id) = cd.cdid)\n' +
  '  GROUP BY cd.cdid, cd.vorname, cd.nachname;\n' +
  // ── Apply ClubDesk Geschlecht → members.sex (fill-only) ──
  // Runs AFTER the linker so members linked this run are filled immediately.
  // sex historically only came from the Volleymanager path (licensed VB players),
  // so basketball/passive/new members stayed empty and the Data Health "Missing
  // sex" list refilled with every new cohort. ClubDesk carries Geschlecht for
  // everyone: fill NULL/empty sex for clubdesk_id-linked members (1:1, unique
  // index) — never overwrite, so VM-sourced values and manual corrections (e.g.
  // a wrong ClubDesk Geschlecht fixed by hand) survive every sync. The
  // count(DISTINCT)=1 guard skips a contact staged with conflicting values.
  // Own transaction, same isolation rationale as the birthdate passes.
  // ── DETECT: stage every ClubDesk→wiedisync change as a proposal (migration 321) ──
  // This replaces five separate write passes (identity, federation, trainer
  // licence, the contact/register block, and the officials flags). They wrote 20
  // statements straight into `members`; this one writes rows into
  // clubdesk_sync_proposals and touches `members` not at all. That is the whole
  // feature and it is worth stating as a testable invariant: A SYNC-DOWN RUN MUST
  // LEAVE `members` BYTE-IDENTICAL apart from the linker above.
  //
  // Every rule the old passes encoded is preserved, only re-expressed as a
  // detection predicate plus a `rule` label the reviewer sees:
  //   fill      — our cell is empty and ClubDesk has something
  //   overwrite — both hold a value, they differ, and ClubDesk's used to win
  //               (⚠ "both hold a value" is a predicate, not a description — see
  //               the five overwrite/fill pairs below)
  //   set_true  — a group/licence-derived boolean the register asserts
  // The value parsing is carried over verbatim (calendar-valid dd.mm.yyyy only,
  // canonical phone only, EAN-13-checked AHV only, country aliases, the trainer
  // ladder, the status picklist) because a proposal must never offer a value the
  // accept step would then refuse to store.
  //
  // ⚠ Keyed on clubdesk_id ALONE. The old licence/email-matched passes are gone
  // (see the note where they used to be) — they are what made the push-pending
  // guard ineffective.
  //
  // ⚠ Three exclusions, all of which used to be missing somewhere:
  //   • clubdesk_push_pending — the member holds an edit on its way UP; proposing
  //     the register's stale value back would invert the two-way contract. Only
  //     the old register-triple pass checked this; now everything does.
  //   • clubdesk_sync_exclude — the "mute" flag (migration 190). The down-sync has
  //     NEVER honoured it: it is checked by the sync-up preview and the group
  //     checks only, so a muted member was still written on every run. That was a
  //     live bug, fixed here.
  //   • a REFUSED proposal for the same (member, field, value) — the tombstone.
  //     Without it a refusal would be re-asked every Saturday forever.
  //
  // ⚠ `austritt` only ever rides with a departed status, exactly as before
  //   (members_austritt_needs_departed_status, migration 302). It is proposed only
  //   when the status the register carries — or ours, if the register says nothing
  //   — is one of the three departed values, so accepting it can never produce the
  //   contradictory pair the CHECK refuses.
  //
  // ⚠ scorer_vb folds in the club rule "a VB referee is automatically a scorer"
  //   (user 2026-07-07). It used to be a separate members-internal UPDATE at the
  //   end of the flags pass; merged here because two proposals for the same
  //   (member, field) cannot coexist under the pending unique index, and because
  //   a silent internal write during a detect-only run would break the invariant
  //   above. The reviewer sees one scorer_vb row either way.
  'BEGIN;\n' +
  'WITH cd0 AS (\n' +
  '  SELECT DISTINCT ON (btrim(clubdesk_id)) btrim(clubdesk_id) AS cdid,\n' +
  "         CASE WHEN geburtsdatum ~ '^[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}$'\n" +
  "                AND to_char(to_date(geburtsdatum,'DD.MM.YYYY'),'DD.MM.YYYY') = geburtsdatum\n" +
  "              THEN to_date(geburtsdatum,'DD.MM.YYYY') END AS cd_dob,\n" +
  "         left(NULLIF(btrim(adresse),''),255) AS cd_adresse,\n" +
  "         left(NULLIF(btrim(plz),''),10) AS cd_plz,\n" +
  "         left(NULLIF(btrim(ort),''),100) AS cd_ort,\n" +
  "         kscw_normalize_phone(left(COALESCE(NULLIF(btrim(telefon_mobil),''), NULLIF(btrim(telefon_privat),'')),255)) AS cd_phone,\n" +
  "         left(NULLIF(btrim(js_id),''),32) AS cd_js_id,\n" +
  "         left(NULLIF(btrim(beitragskategorie),''),100) AS cd_categ,\n" +
  "         left(NULLIF(btrim(sektion),''),32) AS cd_sektion,\n" +
  "         CASE WHEN btrim(status) IN ('Kein Mitglied','Aktivmitglied','Passivmitglied',\n" +
  "                                     'Ehrenmitglied','Ehemaliges Mitglied','Verstorben','Zwischenjahr')\n" +
  '              THEN btrim(status) END AS cd_reg_status,\n' +
  "         CASE WHEN btrim(coalesce(eintritt,'')) ~ '^[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}$'\n" +
  "              THEN to_date(btrim(eintritt),'DD.MM.YYYY') END AS cd_eintritt,\n" +
  "         CASE WHEN btrim(coalesce(austritt,'')) ~ '^[0-9]{2}\\.[0-9]{2}\\.[0-9]{4}$'\n" +
  "              THEN to_date(btrim(austritt),'DD.MM.YYYY') END AS cd_austritt,\n" +
  "         CASE lower(btrim(geschlecht)) WHEN 'männlich' THEN 'm' WHEN 'weiblich' THEN 'f' END AS cd_sex,\n" +
  "         left(NULLIF(btrim(anrede),''),10) AS cd_anrede,\n" +
  "         left(NULLIF(btrim(nationalitaet),''),100) AS cd_nationalitaet,\n" +
  "         regexp_replace(btrim(coalesce(ahv_nummer,'')), '[^0-9]', '', 'g') AS cd_ahv_digits,\n" +
  "         lower(btrim(coalesce(federation_of_origin,''))) AS cd_fed_name,\n" +
  "         lower(btrim(coalesce(trainer_lizenz,''))) AS cd_trainer_raw,\n" +
  "         coalesce(gruppen_bracketed,'') AS cd_gruppen,\n" +
  "         upper(btrim(coalesce(offiziellen_lizenz,''))) AS cd_offliz,\n" +
  "         upper(replace(btrim(coalesce(offiziellen_lizenz,'')), ' ', '')) AS cd_offliz_ns\n" +
  '  FROM clubdesk_export\n' +
  "  WHERE NULLIF(btrim(clubdesk_id),'') IS NOT NULL\n" +
  '  ORDER BY btrim(clubdesk_id), row_id DESC),\n' +
  // Trainer ladder: lift J+S and the BB "Trainer 1|2|3" pairs OUT before the bare
  // VB rungs are matched, or the '+' splits J+S into junk and the 'a' in
  // "Trainer"/"Ausbildung" reads as an A licence. Verbatim from the pass this
  // replaces.
  'cd1 AS (\n' +
  '  SELECT cd0.*,\n' +
  '         regexp_replace(\n' +
  "           regexp_replace(cd_trainer_raw, 'j\\s*\\+?\\s*s|jugend\\s*\\+?\\s*sport', ' ', 'g'),\n" +
  "           'trainer\\s*\\.?\\s*[123]', ' ', 'g') AS cd_rungs\n" +
  '  FROM cd0),\n' +
  'cd AS (\n' +
  '  SELECT cd1.*,\n' +
  // AHV: accept only a 13-digit 756-prefixed value whose EAN-13 mod-10 check digit
  // validates, then re-emit the canonical dotted shape.
  "         CASE WHEN cd_ahv_digits ~ '^756[0-9]{10}$'\n" +
  '               AND (SELECT sum(substr(cd_ahv_digits,g.i,1)::int * CASE WHEN g.i % 2 = 1 THEN 1 ELSE 3 END)\n' +
  '                      FROM generate_series(1,13) g(i)) % 10 = 0\n' +
  "              THEN substr(cd_ahv_digits,1,3)||'.'||substr(cd_ahv_digits,4,4)||'.'||substr(cd_ahv_digits,8,4)||'.'||substr(cd_ahv_digits,12,2)\n" +
  '         END AS cd_ahv,\n' +
  // ⚠⚠ The 'keiner'/'keine'/'none' → 'NONE' branch was REMOVED 2026-08-29.
  // Migration 342 retired that sentinel and members_federation_of_origin_fmt now
  // rejects it outright, so a `fill` proposal carrying it was a guaranteed 500
  // the moment a superadmin accepted it (9 contacts still say "Keiner" in the
  // export). It is dropped rather than re-mapped to 'CH': under 342's definition
  // the register cell carries NO answer, and asserting Swiss origin for a
  // possibly-foreign member is exactly the silent miss 342 exists to stop. NULL
  // here means the `fill` rule's `cd_fed IS NOT NULL` never asks the question.
  '         a.code AS cd_fed,\n' +
  '         (\n' +
  "           SELECT string_agg(code, ',' ORDER BY rank) FROM (\n" +
  "             SELECT 'JS' AS code, 0 AS rank WHERE cd1.cd_trainer_raw ~ 'j\\s*\\+?\\s*s|jugend\\s*\\+?\\s*sport'\n" +
  "             UNION ALL SELECT 'C', 1 WHERE cd1.cd_rungs ~ '(^|[^a-z])c([^a-z]|$)'\n" +
  "             UNION ALL SELECT 'B', 2 WHERE cd1.cd_rungs ~ '(^|[^a-z])b([^a-z]|$)'\n" +
  "             UNION ALL SELECT 'A', 3 WHERE cd1.cd_rungs ~ '(^|[^a-z])a([^a-z]|$)'\n" +
  "             UNION ALL SELECT 'T1', 4 WHERE cd1.cd_trainer_raw ~ 'trainer\\s*\\.?\\s*1'\n" +
  "             UNION ALL SELECT 'T2', 5 WHERE cd1.cd_trainer_raw ~ 'trainer\\s*\\.?\\s*2'\n" +
  "             UNION ALL SELECT 'T3', 6 WHERE cd1.cd_trainer_raw ~ 'trainer\\s*\\.?\\s*3'\n" +
  '           ) t) AS cd_trainer\n' +
  '  FROM cd1 LEFT JOIN country_name_aliases a ON a.alias = cd1.cd_fed_name),\n' +
  // The eligible population. Everything downstream reads `mem`, so the three
  // exclusions are stated exactly once.
  'mem AS (\n' +
  '  SELECT m.*, cd.*\n' +
  '  FROM members m JOIN cd ON cd.cdid = btrim(m.clubdesk_id)\n' +
  '  WHERE m.clubdesk_push_pending IS DISTINCT FROM true\n' +
  '    AND m.clubdesk_sync_exclude IS DISTINCT FROM true),\n' +
  'prop AS (\n' +
  // ── fill: our cell is empty, the register has something ──
  "  SELECT id AS member_id, cdid, 'birthdate' AS field, NULL::text AS current_value, cd_dob::text AS proposed_value, 'fill' AS rule\n" +
  '    FROM mem WHERE birthdate IS NULL AND cd_dob IS NOT NULL\n' +
  "  UNION ALL SELECT id, cdid, 'adresse', NULL, cd_adresse, 'fill'\n" +
  "    FROM mem WHERE NULLIF(btrim(adresse),'') IS NULL AND cd_adresse IS NOT NULL\n" +
  "  UNION ALL SELECT id, cdid, 'plz', NULL, cd_plz, 'fill'\n" +
  "    FROM mem WHERE NULLIF(btrim(plz),'') IS NULL AND cd_plz IS NOT NULL\n" +
  "  UNION ALL SELECT id, cdid, 'ort', NULL, cd_ort, 'fill'\n" +
  "    FROM mem WHERE NULLIF(btrim(ort),'') IS NULL AND cd_ort IS NOT NULL\n" +
  "  UNION ALL SELECT id, cdid, 'phone', NULL, cd_phone, 'fill'\n" +
  "    FROM mem WHERE NULLIF(btrim(phone),'') IS NULL AND cd_phone IS NOT NULL\n" +
  "  UNION ALL SELECT id, cdid, 'js_id', NULL, cd_js_id, 'fill'\n" +
  "    FROM mem WHERE NULLIF(btrim(js_id),'') IS NULL AND cd_js_id IS NOT NULL\n" +
  "  UNION ALL SELECT id, cdid, 'sex', NULL, cd_sex, 'fill'\n" +
  "    FROM mem WHERE (sex IS NULL OR btrim(sex) = '') AND cd_sex IS NOT NULL\n" +
  "  UNION ALL SELECT id, cdid, 'anrede', NULL, cd_anrede, 'fill'\n" +
  "    FROM mem WHERE NULLIF(btrim(anrede),'') IS NULL AND cd_anrede IS NOT NULL\n" +
  "  UNION ALL SELECT id, cdid, 'nationalitaet', NULL, cd_nationalitaet, 'fill'\n" +
  "    FROM mem WHERE NULLIF(btrim(nationalitaet),'') IS NULL AND cd_nationalitaet IS NOT NULL\n" +
  "  UNION ALL SELECT id, cdid, 'ahv_nummer', NULL, cd_ahv, 'fill'\n" +
  "    FROM mem WHERE NULLIF(btrim(ahv_nummer),'') IS NULL AND cd_ahv IS NOT NULL\n" +
  "  UNION ALL SELECT id, cdid, 'federation_of_origin', NULL, cd_fed, 'fill'\n" +
  '    FROM mem WHERE federation_of_origin IS NULL AND cd_fed IS NOT NULL\n' +
  "  UNION ALL SELECT id, cdid, 'trainer_licences', NULL, cd_trainer, 'fill'\n" +
  '    FROM mem WHERE trainer_licences IS NULL AND cd_trainer IS NOT NULL\n' +
  // ── overwrite: both sides hold a value and they differ ──
  //
  // ⚠ `cd IS DISTINCT FROM ours` is ALSO true when ours is NULL, so each of these
  // five carries an explicit "and we hold a value" clause and a `fill` twin below.
  // Without it a column we simply never filled staged as `overwrite`, which the
  // queue renders "Values disagree" — announcing a conflict against a blank. It
  // read as a broken sync at the moment the sync had worked: the two contacts our
  // CREATE push made on 03.09.2026 came back carrying ClubDesk's own Eintritt,
  // Mitgliederstatus and Sektion — the register answering the create, exactly what
  // step 4 is for — and the operator was shown six disagreements over six empty
  // cells (migration 356 relabelled the rows already queued).
  //
  // The `rule` is the ONLY thing that differs between each pair: the accept path
  // writes the same value either way. It is a label for the human deciding, and
  // "ours is empty" and "we disagree" are not the same question.
  "  UNION ALL SELECT id, cdid, 'beitragskategorie', beitragskategorie, cd_categ, 'overwrite'\n" +
  "    FROM mem WHERE cd_categ IS NOT NULL AND NULLIF(btrim(beitragskategorie),'') IS NOT NULL\n" +
  "      AND cd_categ IS DISTINCT FROM NULLIF(btrim(beitragskategorie),'')\n" +
  "  UNION ALL SELECT id, cdid, 'beitragskategorie', NULL, cd_categ, 'fill'\n" +
  "    FROM mem WHERE cd_categ IS NOT NULL AND NULLIF(btrim(beitragskategorie),'') IS NULL\n" +
  "  UNION ALL SELECT id, cdid, 'sektion', sektion, cd_sektion, 'overwrite'\n" +
  "    FROM mem WHERE cd_sektion IS NOT NULL AND NULLIF(btrim(sektion),'') IS NOT NULL\n" +
  "      AND cd_sektion IS DISTINCT FROM NULLIF(btrim(sektion),'')\n" +
  "  UNION ALL SELECT id, cdid, 'sektion', NULL, cd_sektion, 'fill'\n" +
  "    FROM mem WHERE cd_sektion IS NOT NULL AND NULLIF(btrim(sektion),'') IS NULL\n" +
  "  UNION ALL SELECT id, cdid, 'register_status', register_status, cd_reg_status, 'overwrite'\n" +
  "    FROM mem WHERE cd_reg_status IS NOT NULL AND NULLIF(btrim(register_status),'') IS NOT NULL\n" +
  '      AND cd_reg_status IS DISTINCT FROM register_status\n' +
  "  UNION ALL SELECT id, cdid, 'register_status', NULL, cd_reg_status, 'fill'\n" +
  "    FROM mem WHERE cd_reg_status IS NOT NULL AND NULLIF(btrim(register_status),'') IS NULL\n" +
  "  UNION ALL SELECT id, cdid, 'eintritt', eintritt::text, cd_eintritt::text, 'overwrite'\n" +
  '    FROM mem WHERE cd_eintritt IS NOT NULL AND eintritt IS NOT NULL\n' +
  '      AND cd_eintritt IS DISTINCT FROM eintritt\n' +
  "  UNION ALL SELECT id, cdid, 'eintritt', NULL, cd_eintritt::text, 'fill'\n" +
  '    FROM mem WHERE cd_eintritt IS NOT NULL AND eintritt IS NULL\n' +
  // Austritt travels only with a departed status — see the ⚠ above. The departed
  // clause guards BOTH halves: an exit date under a still-active status aborts on
  // members_austritt_needs_departed_status, whether we hold one already or not.
  "  UNION ALL SELECT id, cdid, 'austritt', austritt::text, cd_austritt::text, 'overwrite'\n" +
  '    FROM mem WHERE cd_austritt IS NOT NULL AND austritt IS NOT NULL\n' +
  '      AND cd_austritt IS DISTINCT FROM austritt\n' +
  "      AND COALESCE(cd_reg_status, register_status) IN ('Kein Mitglied','Ehemaliges Mitglied','Verstorben')\n" +
  "  UNION ALL SELECT id, cdid, 'austritt', NULL, cd_austritt::text, 'fill'\n" +
  '    FROM mem WHERE cd_austritt IS NOT NULL AND austritt IS NULL\n' +
  "      AND COALESCE(cd_reg_status, register_status) IN ('Kein Mitglied','Ehemaliges Mitglied','Verstorben')\n" +
  // ── set_true: the register asserts a qualification we do not hold ──
  // Never a clearing rule: ClubDesk holds ONE value per contact while a member can
  // hold several licences, so absence from the cell is absence of evidence.
  "  UNION ALL SELECT id, cdid, 'referee_vb', coalesce(referee_vb::text,'false'), 'true', 'set_true'\n" +
  '    FROM mem WHERE referee_vb IS DISTINCT FROM true\n' +
  "      AND cd_gruppen ~* '(^|,)\\s*VB Schiedsrichter\\*innen\\s*(,|$)'\n" +
  "  UNION ALL SELECT id, cdid, 'referee_bb', coalesce(referee_bb::text,'false'), 'true', 'set_true'\n" +
  '    FROM mem WHERE referee_bb IS DISTINCT FROM true\n' +
  "      AND cd_gruppen ~* '(^|,)\\s*Schiedsrichter BB\\s*(,|$)'\n" +
  "  UNION ALL SELECT id, cdid, 'scorer_vb', coalesce(scorer_vb::text,'false'), 'true', 'set_true'\n" +
  '    FROM mem WHERE scorer_vb IS DISTINCT FROM true\n' +
  "      AND (cd_offliz = 'VB SC' OR referee_vb IS TRUE)\n" +
  "  UNION ALL SELECT id, cdid, 'otr1_bb', coalesce(otr1_bb::text,'false'), 'true', 'set_true'\n" +
  "    FROM mem WHERE otr1_bb IS DISTINCT FROM true AND cd_offliz = 'OTR1'\n" +
  "  UNION ALL SELECT id, cdid, 'otr2_bb', coalesce(otr2_bb::text,'false'), 'true', 'set_true'\n" +
  "    FROM mem WHERE otr2_bb IS DISTINCT FROM true AND cd_offliz = 'OTR2'\n" +
  "  UNION ALL SELECT id, cdid, 'otn1_bb', coalesce(otn1_bb::text,'false'), 'true', 'set_true'\n" +
  "    FROM mem WHERE otn1_bb IS DISTINCT FROM true AND cd_offliz_ns = 'OTN1'\n" +
  "  UNION ALL SELECT id, cdid, 'otn2_bb', coalesce(otn2_bb::text,'false'), 'true', 'set_true'\n" +
  "    FROM mem WHERE otn2_bb IS DISTINCT FROM true AND cd_offliz_ns = 'OTN2'),\n" +
  'ins AS (\n' +
  '  INSERT INTO clubdesk_sync_proposals (member_id, clubdesk_id, field, current_value, proposed_value, rule)\n' +
  '  SELECT p.member_id, p.cdid, p.field, p.current_value, p.proposed_value, p.rule\n' +
  '  FROM prop p\n' +
  // The tombstone. A refused row is `refused`, so it never collides with the
  // pending unique index below — it has to be excluded explicitly or a refusal
  // would be re-proposed on every single run.
  '  WHERE NOT EXISTS (SELECT 1 FROM clubdesk_sync_proposals x\n' +
  "                     WHERE x.status = 'refused' AND x.member_id = p.member_id\n" +
  '                       AND x.field = p.field\n' +
  '                       AND x.proposed_value IS NOT DISTINCT FROM p.proposed_value)\n' +
  // Targetless: the pending partial unique is what this hits, and naming a
  // conflict target that is a PARTIAL index is the trap this codebase has already
  // been bitten by. DO NOTHING makes a re-run a no-op instead of a duplicate.
  '  ON CONFLICT DO NOTHING\n' +
  '  RETURNING 1)\n' +
  "SELECT 'clubdesk_field_proposals' AS metric, count(*) AS value FROM ins;\n" +
  'COMMIT;\n' +
  "SELECT 'clubdesk_proposals_pending' AS metric,\n" +
  "  (SELECT count(*) FROM clubdesk_sync_proposals WHERE status = 'pending') AS value;\n" +
  // Linked contacts whose ClubDesk cell says a level-less 'OTN' and whose member
  // row carries neither Basketplan level — nobody today, and a non-zero value
  // means somebody's table-officials eligibility is riding on a cell wiedisync
  // can no longer represent. Resolve it in Basketplan, or set the level by hand.
  "SELECT 'members_otn_unresolved' AS metric, (SELECT count(*) FROM members m\n" +
  "  JOIN clubdesk_export c ON btrim(c.clubdesk_id) = btrim(m.clubdesk_id)\n" +
  "  WHERE upper(btrim(c.offiziellen_lizenz)) = 'OTN'\n" +
  "    AND m.otn1_bb IS DISTINCT FROM true AND m.otn2_bb IS DISTINCT FROM true) AS value;\n" +
  // Report contacts that would have matched MULTIPLE still-unlinked members (skipped
  // above) so a human can link them manually — "ambiguous, needs manual link".
  'WITH cd AS (\n' +
  '  SELECT btrim(clubdesk_id) cdid, lower(btrim(email)) email, lower(btrim(email_alternativ)) email_alt,\n' +
  "         lower(btrim(nachname)) nachname, lower(split_part(btrim(vorname),' ',1)) vn1\n" +
  "  FROM clubdesk_export WHERE NULLIF(btrim(clubdesk_id),'') IS NOT NULL),\n" +
  'ambig AS (\n' +
  '  SELECT cd.cdid, mm.id AS member_id FROM members mm\n' +
  "  JOIN cd ON NULLIF(btrim(mm.email),'') IS NOT NULL AND lower(btrim(mm.email)) IN (cd.email, cd.email_alt)\n" +
  '       AND lower(btrim(mm.last_name)) = cd.nachname\n' +
  // Blank-first-name guard (audit #15): a member with an empty first_name makes
  // split_part('',' ',1)='' → `cd.vn1 LIKE '%'` = TRUE for every contact, so the
  // first-name guard collapses to match-all. Require both sides non-empty.
  "       AND NULLIF(split_part(btrim(mm.first_name),' ',1),'') IS NOT NULL AND NULLIF(cd.vn1,'') IS NOT NULL\n" +
  "       AND (lower(split_part(btrim(mm.first_name),' ',1)) LIKE cd.vn1 || '%'\n" +
  "            OR cd.vn1 LIKE lower(split_part(btrim(mm.first_name),' ',1)) || '%')\n" +
  '  WHERE mm.clubdesk_id IS NULL)\n' +
  "SELECT 'clubdesk_link_ambiguous' AS metric, cdid,\n" +
  "       string_agg(member_id::text, ',' ORDER BY member_id) AS member_ids\n" +
  '  FROM ambig GROUP BY cdid HAVING count(DISTINCT member_id) > 1;\n' +
  // ── Refresh public_stats.member_count (kscw-website About page) ──
  // The website shows a live member count from the prod public_stats collection
  // (public read on directus.kscw.ch /items/public_stats). Its Directus flow
  // ("Public stats: recount") only fires on API writes — this raw-SQL channel
  // bypasses the event bus — so refresh the count here explicitly after the
  // create pass above. to_regclass-guarded: the dev DB has no public_stats and
  // ON_ERROR_STOP=1 would otherwise abort the whole import.
  'DO $$ BEGIN\n' +
  "  IF to_regclass('public.public_stats') IS NOT NULL THEN\n" +
  '    UPDATE public.public_stats\n' +
  '       SET value = (SELECT count(*) FROM public.members WHERE kscw_membership_active),\n' +
  '           date_updated = now()\n' +
  "     WHERE id = 'member_count';\n" +
  '  END IF;\n' +
  'END $$;\n' +
  "SELECT 'members_active_total' AS metric, (SELECT count(*) FROM members WHERE kscw_membership_active) AS value;\n"

if (EMIT_SQL) {
  // Flush fully before exiting: process.exit() right after writing a large
  // payload to a pipe/file truncates it (the write is async). Exit only once
  // the buffer has drained via the write callback.
  process.stdout.write(psqlInput, () => process.exit(0))
} else {
  console.error(`→ ${envName}/${env.database}: importing ${csvPath} (${dataRows.length} data rows, ${TARGET_COLS.length} target cols)...`)
  const dockerExec = ['sudo', 'docker', 'exec', '-i', env.container,
    'psql', '-U', env.user, '-d', env.database,
    '-X', '-v', 'ON_ERROR_STOP=1']
  const cmd = LOCAL ? dockerExec : ['ssh', 'hetzner', ...dockerExec]
  const r = spawnSync(cmd[0], cmd.slice(1), { input: psqlInput, encoding: 'utf-8' })
  if (r.status !== 0) {
    console.error('psql failed:')
    console.error(r.stderr || r.stdout)
    process.exit(1)
  }
  process.stdout.write(r.stdout)
  console.log('✓ import complete')
}
