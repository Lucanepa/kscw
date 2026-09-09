/**
 * ClubDesk Data Update — sends CSV email to admin when member updates ClubDesk-relevant fields
 * POST /kscw/clubdesk-update — authenticated
 */

import { buildEmailLayout, buildInfoCard, bucketEmailsByLocale } from './email-template.js'
import { writeUserLog } from './activity-log.js'
import { currentSeasonShort } from './season.js'
import { normalizePhone, normalizeIban, normalizeAhv, normalizeEmail } from './normalize.js'
import {
  countryCodesDisplay, federationDisplay, loadCountryDisplayNames, parseCodeList,
  sexDisplay, sexPushLabel,
} from './federations.js'
import { resolveMemberSportsDetailed } from './member-sport.js'

/** Canonical form for an outgoing push cell; unrewritable values pass raw
 *  (result.value carries the raw input when ok is false). */
const normVal = (fn, v) => fn(v).value || ''

// ⚠ Was hardcoded to a personal Gmail, so it ignored the OWNER_EMAIL container
// env and stayed behind when every other consumer moved. Reads the env now.
// The club admin mailbox has no `members` row, so bucketEmailsByLocale falls it
// into `de` — which is the right language for it, and it is still delivered.
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'admin@wiedisync.kscw.ch'
const ADMIN_EMAIL = 'kontakt@kscw.ch'

/** Current season in Wiedisync short form, e.g. '2025/26' (matches member_teams.season). June cutover — same as src/utils/dateHelpers.ts. */
const getCurrentSeason = currentSeasonShort

// Per-locale display labels for DB field names.
// ⚠ A field missing here prints its raw snake_case column name at a human
// ("federation_of_origin", live until 2026-07-26) — keep this in step with
// EDITABLE in /clubdesk-update. Wording mirrors the `auth` i18n namespace.
const FIELD_LABELS = {
  de: {
    first_name: 'Vorname', last_name: 'Nachname', email: 'E-Mail', phone: 'Telefon',
    birthdate: 'Geburtsdatum', anrede: 'Anrede', adresse: 'Adresse', plz: 'PLZ', ort: 'Ort',
    nationalitaet: 'Nationalität', sex: 'Geschlecht', ahv_nummer: 'AHV-Nummer',
    federation_of_origin: 'Herkunftsverband', trainer_licences: 'Trainerausbildung', iban: 'IBAN',
  },
  gsw: {
    first_name: 'Vorname', last_name: 'Nachname', email: 'E-Mail', phone: 'Telefon',
    birthdate: 'Geburtsdatum', anrede: 'Aaräde', adresse: 'Adrässe', plz: 'PLZ', ort: 'Ort',
    nationalitaet: 'Nationalität', sex: 'Gschlächt', ahv_nummer: 'AHV-Nummer',
    federation_of_origin: 'Herkunftsverband', trainer_licences: 'Trainerusbildig', iban: 'IBAN',
  },
  en: {
    first_name: 'First name', last_name: 'Last name', email: 'Email', phone: 'Phone',
    birthdate: 'Date of birth', anrede: 'Salutation', adresse: 'Address', plz: 'Zip', ort: 'City',
    nationalitaet: 'Nationality', sex: 'Sex', ahv_nummer: 'AHV number',
    federation_of_origin: 'Federation of origin', trainer_licences: 'Coaching qualification', iban: 'IBAN',
  },
  fr: {
    first_name: 'Prénom', last_name: 'Nom', email: 'E-mail', phone: 'Téléphone',
    birthdate: 'Date de naissance', anrede: 'Salutation', adresse: 'Adresse', plz: 'NPA', ort: 'Localité',
    nationalitaet: 'Nationalité', sex: 'Sexe', ahv_nummer: "Numéro d'AVS",
    federation_of_origin: "Fédération d'origine", trainer_licences: "Formation d'entraîneur", iban: 'IBAN',
  },
  it: {
    first_name: 'Nome', last_name: 'Cognome', email: 'E-mail', phone: 'Telefono',
    birthdate: 'Data di nascita', anrede: 'Appellativo', adresse: 'Indirizzo', plz: 'CAP', ort: 'Località',
    nationalitaet: 'Nazionalità', sex: 'Sesso', ahv_nummer: 'Numero AVS',
    federation_of_origin: 'Federazione di origine', trainer_licences: 'Formazione da allenatore', iban: 'IBAN',
  },
}

const T = {
  de: {
    title: 'ClubDesk Datenanpassung',
    subject: name => `[KSCW] Datenanpassung: ${name}`,
    intro: 'Folgende Daten wurden vom Mitglied aktualisiert und müssen in ClubDesk übernommen werden:',
    currentData: 'Aktuelle Daten',
    name: 'Name', email: 'E-Mail', phone: 'Telefon', team: 'Team',
    field: 'Feld', oldValue: 'Alt', newValue: 'Neu',
  },
  gsw: {
    title: 'ClubDesk Datenaapassig',
    subject: name => `[KSCW] Datenaapassig: ${name}`,
    intro: 'Folgendi Date sind vom Mitglied aktualisiert worde und müend i ClubDesk übernoh werde:',
    currentData: 'Aktuelli Date',
    name: 'Name', email: 'E-Mail', phone: 'Telefon', team: 'Team',
    field: 'Fäld', oldValue: 'Alt', newValue: 'Neu',
  },
  en: {
    title: 'ClubDesk Data Update',
    subject: name => `[KSCW] Data update: ${name}`,
    intro: 'The following data was updated by the member and needs to be applied in ClubDesk:',
    currentData: 'Current data',
    name: 'Name', email: 'Email', phone: 'Phone', team: 'Team',
    field: 'Field', oldValue: 'Old', newValue: 'New',
  },
  fr: {
    title: 'Mise à jour ClubDesk',
    subject: name => `[KSCW] Mise à jour : ${name}`,
    intro: "Les données suivantes ont été mises à jour par le membre et doivent être reportées dans ClubDesk :",
    currentData: 'Données actuelles',
    name: 'Nom', email: 'E-mail', phone: 'Téléphone', team: 'Équipe',
    field: 'Champ', oldValue: 'Ancien', newValue: 'Nouveau',
  },
  it: {
    title: 'Aggiornamento ClubDesk',
    subject: name => `[KSCW] Aggiornamento: ${name}`,
    intro: 'I seguenti dati sono stati aggiornati dal socio e devono essere riportati in ClubDesk:',
    currentData: 'Dati attuali',
    name: 'Nome', email: 'E-mail', phone: 'Telefono', team: 'Squadra',
    field: 'Campo', oldValue: 'Vecchio', newValue: 'Nuovo',
  },
}

const CD_LOCALES = ['de', 'gsw', 'en', 'fr', 'it']

const CSV_HEADERS = [
  'Anrede', 'Vorname', 'Nachname', 'E-Mail', 'Telefon',
  'Adresse', 'PLZ', 'Ort', 'Geburtsdatum', 'Nationalität',
  'Geschlecht', 'AHV', 'Team', 'Beitragskategorie',
]

function escCsv(val) {
  let s = String(val ?? '')
  // Neutralize spreadsheet formula injection: a cell that starts with =, @,
  // (or a tab/CR) is interpreted as a formula by Excel/ClubDesk. These CSVs
  // carry member-controlled fields, so prefix such cells with a single quote to
  // force literal text before applying the usual quoting. Leading '+'/'-'
  // followed by a digit, space or '(' is phone-style DATA and stays unguarded
  // (the blanket guard put literal apostrophes into ClubDesk phone fields —
  // see cdCell); any other '+'/'-' prefix (e.g. +HYPERLINK) is still escaped.
  if (/^[=@\t\r]/.test(s) || /^[+-](?![\d( ])/.test(s)) s = `'${s}`
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s
}

function buildCsv(data, teamNames) {
  const row = [
    data.anrede, data.first_name, data.last_name, data.email, data.phone,
    data.adresse, data.plz, data.ort, data.birthdate, data.nationalitaet,
    data.sex, data.ahv_nummer, teamNames, data.beitragskategorie,
  ]
  return CSV_HEADERS.join(',') + '\n' + row.map(escCsv).join(',')
}

// ClubDesk's CSV interface is Windows-1252, not UTF-8 (its export is CP1252 and
// the scripted sync-up push iconv-transcodes before upload — see
// clubdesk-member-up-dispatch.sh). The emailed CSVs get imported into ClubDesk by
// hand, so a UTF-8 attachment mangles every accented name (ü → Ã¼). Encode CP1252
// and transliterate the few letters CP1252 can't hold (ć → c, ń → n) instead of
// shipping mojibake into the legal member register.
const CP1252_EXTRA = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8A,
  '‹': 0x8B, 'Œ': 0x8C, 'Ž': 0x8E, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9A, '›': 0x9B, 'œ': 0x9C,
  'ž': 0x9E, 'Ÿ': 0x9F,
}
// Letters with no CP1252 slot and no combining-mark decomposition — stripping
// accents gets you nowhere, so they need naming. Without 'ı' a Turkish member
// ("Işık", "Altınbaş" — not rare in Zurich) landed in the register as "Is?k".
// kscw-website's admin.astro CP1252_TRANSLIT and registration-form.js
// NON_DECOMPOSING must match this exactly: all three write the same person's
// name, and a table that drifts spells one member two ways.
const CP1252_TRANSLIT = {
  'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L',
  'ı': 'i', 'ħ': 'h', 'Ħ': 'H', 'ŧ': 't', 'Ŧ': 'T',
}
export function toCp1252Buffer(str) {
  const bytes = []
  const pushChar = (ch) => {
    const cp = ch.codePointAt(0)
    if (cp <= 0x7F || (cp >= 0xA0 && cp <= 0xFF)) { bytes.push(cp); return true }
    if (CP1252_EXTRA[ch] !== undefined) { bytes.push(CP1252_EXTRA[ch]); return true }
    return false
  }
  for (const ch of str) {
    if (pushChar(ch)) continue
    const base = CP1252_TRANSLIT[ch] || ch.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    let ok = base.length > 0
    const mark = bytes.length
    for (const b of base) if (!pushChar(b)) { ok = false; break }
    if (!ok) { bytes.length = mark; bytes.push(0x3F) } // '?'
  }
  return Buffer.from(bytes)
}

// ── Sync-up push CSV (member → ClubDesk import) ─────────────────────────────
// Headers are the EXACT ClubDesk field names so the import wizard auto-maps every
// column (verified live 2026-06-27 — "Telefon Privat" not "Telefon"). Semicolon-
// delimited (ClubDesk's import default). UPDATE rows carry CONTACT fields plus
// three FILL-ONLY billing cells (Beitragskategorie/Eintritt/Mitgliederbeitrag,
// 2026-07-27 — ClubDesk's own value always wins, see CD_PUSH_HEADERS) — never
// groups/teams/status (ClubDesk-managed on existing contacts); CREATE rows
// additionally carry Beitragskategorie + Eintritt + Gruppen + Status (see
// CD_PUSH_CREATE_HEADERS below).
//
// UPDATE rows are keyed on ClubDesk's own [Id] (= members.clubdesk_id) since
// 2026-07-08. A `[Id]` CSV column is consumed by the import wizard as the RECORD
// IDENTITY — it never appears in the field-mapping list, and the row upserts the
// matched contact regardless of name/email. Spike-proven live (2026-07-08,
// throwaway contact, created→updated→deleted):
//   • [Id]-matched commit updates ONLY the columns present in the CSV — every
//     absent column stays byte-identical (incl. Vorname/Nachname/E-Mail).
//   • An EMPTY mapped cell does NOT blank the stored value (full no-op) — the
//     echo-back + blank-risk guards below stay as defense-in-depth anyway.
//   • An UNKNOWN [Id] hard-aborts the ENTIRE import (wizard closes, no summary,
//     nothing written) → /up's stale-link guard must skip members whose contact
//     vanished from ClubDesk before the CSV is stashed.
// Vorname/Nachname are deliberately ABSENT from UPDATE rows: the push carries
// contact data, never a rename, and ClubDesk's name-matching (its only other
// update path) breaks on any name drift — short↔full first names, nicknames,
// married/double surnames, accents, CD-side typos, non-CP1252 chars (ć→?).
// Without [Id] those rows previewed as "Neue" and the up-dispatcher's dup guard
// refused the whole set (17 refused on 2026-07-07). CREATE rows keep the real
// wiedisync name — a brand-new contact needs one, and it has no [Id] yet.
//
// wiedisync is NOT the source of truth for every pushed column. IBAN joined the
// push scope 2026-07-06 (member-entered via PayoutIbanCard / finance edits —
// wiedisync owns it once set), but the down-sync deliberately does NOT fill
// members.iban (deleted-IBAN resurrection, see import-clubdesk-csv.mjs), so most
// members are empty here while ClubDesk holds a value → /up ECHOES ClubDesk's
// own IBAN back into the cell when wiedisync's is empty. A member-entered IBAN
// always wins.
//
// Shared contact columns (both sets, order fixed — buildPushCsv mirrors it):
const CD_PUSH_CONTACT_HEADERS = [
  'E-Mail', 'Telefon Privat', 'Adresse',
  'PLZ', 'Ort', 'Geburtsdatum', 'Geschlecht', 'IBAN',
  // Anrede/Nationalität/AHV Nummer joined the push scope 2026-07-07: the
  // down-sync now fills members.anrede/nationalitaet/ahv_nummer, so wiedisync
  // holds them, and /up ECHOES ClubDesk's own value back into any empty cell
  // (like IBAN) — an empty wiedisync field can never blank the register. Anrede
  // and Nationalität are ClubDesk PICKLISTS (values come from the down-sync so
  // they already match); AHV Nummer is free text (pushing wiedisync's clean
  // value also repairs ClubDesk cells the Zahl-format once mangled).
  'Anrede', 'Nationalität',
  // Federation of Origin (custom ClubDesk field, 2026-07-25): the national
  // federation the member was FIRST licensed with (their federation of origin) —
  // the key the club needs for a
  // Swiss Volley transfer certificate / FIBA letter of clearance before the
  // player may be licensed here. Asked on the registration form and editable in
  // the profile, so WIEDISYNC owns it (ClubDesk has no other source); stored as
  // an ISO alpha-2 code (migration 223; the 'NONE' sentinel was retired by 342)
  // and mapped to ClubDesk's German picklist wording on the way out — see
  // federationCell.
  // Echo-protected exactly like Nationalität: an unanswered wiedisync field
  // sends ClubDesk's own value back instead of an empty cell.
  'Federation of Origin',
  // Trainer Lizenz (custom ClubDesk field, 2026-08-03): coaching education —
  // J+S plus/or the C/B/A ladder (members.trainer_licences, migration 274).
  // Members declare it in their own profile and ClubDesk has no other source,
  // so WIEDISYNC owns it. ⚠ The field is deliberately **Text**, not the Auswahl
  // picklist it was first created as: wiedisync stores a SET (J+S is a separate
  // track from the ladder, so "JS,B" is ordinary) and a single-select cell would
  // have forced a lossy collapse. trainerLicenceCell renders the set in
  // ClubDesk's own wording ("J+S, B"). Echo-protected exactly like Federation of
  // Origin — an unanswered member sends ClubDesk's cell back, never a blank.
  'Trainer Lizenz',
  'AHV Nummer',
  // Wiedisync ID (custom ClubDesk text field, 2026-07-07): wiedisync's member
  // UUID (members.uuid, migration 184 — globally unique, visually distinct from
  // ClubDesk's own numeric [Id]; pre-184 stamps carried the numeric members.id
  // and stay valid — the linker accepts both). Pushed on EVERY create + update;
  // wiedisync fully owns it (never echo, never empty), so the down-sync can
  // link contact↔member by this exact key — immune to the name/email/accent
  // drift that email+name matching suffers. This closes the create round-trip
  // (up → new [Id] → down-link) with zero ambiguity. ClubDesk's import can't
  // MATCH on it (spike-proven 2026-07-08: a Wiedisync-ID-only row previews as
  // "Neue" — only ClubDesk's own [Id] is an upsert key), but the down-sync
  // linker reads it back as the authoritative key.
  'Wiedisync ID',
  // Gast (custom ClubDesk Ja/Nein field, created 2026-07-27): does this member
  // train with a team as a GUEST this season. ClubDesk has no source for it —
  // the roster lives in `member_teams.guest_level` — so wiedisync owns the
  // column outright: never echoed, and never empty (see gastCell).
  // ⚠ The definition is guestMemberIdSet's, NOT a bare `guest_level > 0`: a
  // guest on one team who is a CORE player on another is a full member and is
  // billed as one (deriveMitgliederbeitrag isGuest), so only "guest somewhere
  // AND core nowhere" is a Gast. Using the looser rule here would contradict
  // the fee the same push writes. Backfilled 2026-07-27 (27 Ja / 680 Nein
  // across the 707 linked contacts) — see docs/DEVLOG.md.
  'Gast',
]
// UPDATE set: [Id]-keyed, name-less (see block comment above).
// Beitragskategorie + Eintritt + Mitgliederbeitrag joined the UPDATE set
// 2026-07-27 as FILL-ONLY update-CSV extras (NOT CD_PUSH_CONTACT_HEADERS —
// the create set carries its own copies at their historical positions,
// mirroring how the create extras work). Why: a contact created ClubDesk-side
// first and linked afterwards never goes through a CREATE row, so those three
// stayed empty in the register forever (member 525 / contact 1001301). Fill-
// only = the /up echo stashes ClubDesk's OWN cell (`*_cd`) and buildPushCsv
// sends it verbatim whenever it is non-empty (a no-op on import); wiedisync's
// value goes out ONLY when ClubDesk's cell is empty. Same guarantee as the
// anrede/nationalitaet echo with the precedence REVERSED — ClubDesk stays
// authoritative on existing contacts, and per-person Mitgliederbeitrag
// overrides ("Speziallizenz, einmalig so tief") are sacred.
// Lizenznummer + Lizenzart joined 2026-07-27 under the same fill-only rule:
// wiedisync's license_nr / licence_category come from the issuing authorities
// (Volleymanager / Basketplan, migrations 208 + 260), but the register cell may
// be hand-maintained — so ClubDesk wins where set, and only the ~198 empty
// number / ~320 empty art cells get filled. Divergent cells (3 at ship time)
// stay ClubDesk's and need a manual decision, never an automated overwrite.
// ── The register triple (migration 302) ──────────────────────────────────────
// Status / Eintritt / Austritt are the first ClubDesk-OWNED cells an UPDATE row
// may write. Everything above this line is either a field wiedisync owns
// outright or a fill-only cell that echoes ClubDesk's value back verbatim; these
// three genuinely overwrite the legal register, so they are the one place the
// "ClubDesk is authoritative on existing contacts" rule is relaxed.
//
// It is relaxed as narrowly as it can be: a cell is only sent when the member's
// OWN pending change names that field (registerCell() below reads
// clubdesk_push_changes, which the members.items.update hook writes). A member
// flagged for a push because their IBAN changed therefore still echoes
// ClubDesk's Status back untouched — without that gate, every unrelated push
// would rewrite the register's status from a wiedisync copy up to a week stale,
// and a status changed IN ClubDesk between two sync-downs would be silently
// reverted.
//
// ⚠ Eintritt moved from the fill-only set into this one. Its old precedence
// (ClubDesk always wins, wiedisync's registration date only fills an empty
// cell) is still exactly what happens for every member who has not edited it —
// registerCell falls through to the same echo. What changed is that an entry
// date corrected in the Data Explorer now reaches the register instead of being
// discarded on the next push.
// `beitragskategorie` joined on 2026-08-14 for the same reason `eintritt` did:
// a value corrected in wiedisync was being discarded on every push AND reverted
// by the next sync-down. Nothing iterates this list in code — it is the written
// contract for which cells an UPDATE row may overwrite, and reviewers diff it.
export const CD_REGISTER_FIELDS = ['register_status', 'eintritt', 'austritt', 'beitragskategorie']

/**
 * Register statuses that mean "no longer one of ours".
 *
 * Module scope since 2026-08-10 because buildPushCsv needs it too (an Austritt
 * cell may only ride with a departed Status cell). Previously a local inside the
 * router — one definition, three readers now: the push, the Data Health
 * "departed in ClubDesk" check and the per-member sync verdict.
 *
 * ⚠ Mirrors DEPARTED_REGISTER_STATUSES in src/modules/admin/components/
 * memberFieldOptions.ts and the CHECK constraint
 * members_austritt_needs_departed_status (migration 302). 'Zwischenjahr' is
 * deliberately absent: a gap year is a member taking a season off.
 */
export const DEPARTED_STATUSES = ['Kein Mitglied', 'Ehemaliges Mitglied', 'Verstorben']

const CD_PUSH_HEADERS = ['[Id]', ...CD_PUSH_CONTACT_HEADERS, 'Beitragskategorie', 'Eintritt', 'Mitgliederbeitrag', 'Lizenznummer', 'Lizenzart', 'Status', 'Austritt', 'Offiziellen Lizenz']

// ── CREATE-set extras (new ClubDesk contacts only) ───────────────────────────
// A brand-new contact has no ClubDesk-owned category, entry date, groups or
// status to protect, so the CREATE-set CSV additionally carries
// Beitragskategorie (captured by the signup form →
// registrations.beitragskategorie → members.beitragskategorie via the approval
// hook), Eintritt (the registration submission date — per user rule 2026-07-06
// "the date the registration is sent", NOT approved_at), Gruppen (derived
// from the registration's team + funktion: `VB H1 (Spieler*in)`,
// `BB HU14 (Trainer*in)` — ClubDesk's group naming, verified against the export
// snapshot 2026-07-05), Status (Aktiv-/Passivmitglied — see deriveStatus) and
// Offiziellen Lizenz (scorer/officials licence — see deriveOffiziellenLizenz).
// UPDATE pushes NEVER send Gruppen/Sektion/Schiedsrichter/Telefon Mobil —
// ClubDesk stays authoritative on existing contacts. (Spike 2026-07-08: an
// empty mapped cell is provably a no-op on import, but keeping these columns
// out of the update set remains the structural guarantee — one probe on one
// field type is no licence to send status cells at existing contacts.)
// Beitragskategorie + Eintritt + Mitgliederbeitrag are the 2026-07-27
// exception: they ride on UPDATE rows too, but FILL-ONLY — ClubDesk's own
// value is echoed back verbatim whenever it exists, so an update can only
// ever fill a cell the register left empty (see CD_PUSH_HEADERS). Status +
// Austritt joined on 2026-08-10 under the NARROWER registerCell gate (the
// push must name the field). That is why /up stashes TWO CSVs (up_csv +
// up_csv_create) instead of one.
// ⚠ Offiziellen Lizenz joined the UPDATE set on 2026-08-14, and it is the
// WEAKEST of the three regimes on purpose: strictly fill-only, with no
// registerCell gate at all. The reason is the one documented at
// deriveOffiziellenLizenz — ClubDesk's picklist is single-valued while
// wiedisync models the rungs as independent booleans, so any rule that lets
// wiedisync overwrite has to CHOOSE a rung for the 43 members holding
// otr1_bb AND otr2_bb. Echoing a non-empty register cell verbatim means it
// never has to choose: on prod at introduction, 298 members with an
// officials flag already had a register value (untouched) and 32 had an
// empty one (filled). Promote this to registerCell only with a dual-holder
// guard — see the ⚠ HIGHEST RUNG FIRST note.
// ⚠ Gruppen maps in the import wizard as free TEXT and a commit does NOT
// create the group membership (PROVEN 2026-07-06: Månsson/Clüver creates
// carried Gruppen, landed with empty groups). The column stays as harmless
// self-documentation in the import preview — group assignment is manual in
// ClubDesk.
// CREATE rows also duplicate the single member phone into Telefon Mobil (user
// 2026-07-06: "unless present, Privat and Mobil the same"), and carry Sektion
// (Volleyball/Basketball/KSCW). These are CREATE-only — an UPDATE never
// overwrites a distinct Mobil / ClubDesk-owned Sektion on an existing contact.
// ⚠ The Passivmitglied Ja/Nein checkbox was dropped from this set on
// 2026-07-30: the field was DELETED in ClubDesk (a club-side custom checkbox
// predating the sync, redundant with Status + Beitragskategorie, and drifted
// from both — 21 live contradictions at deletion time). Passive membership
// travels on Status alone now (deriveStatus → 'Passivmitglied'). Last values
// archived to .planning/clubdesk-backups/passivmitglied-snapshot-20260730.csv.
// CREATE set: real wiedisync name (a brand-new contact has no [Id] to key on),
// the shared contact columns, then the create-only extras.
export const CD_PUSH_CREATE_HEADERS = ['Vorname', 'Nachname', ...CD_PUSH_CONTACT_HEADERS, 'Telefon Mobil', 'Beitragskategorie', 'Eintritt', 'Gruppen', 'Status', 'Offiziellen Lizenz', 'Mitgliederbeitrag', 'Sektion', 'Schiedsrichter', 'Lizenznummer', 'Lizenzart', 'Austritt']

// Sport prefix for ClubDesk group names (`VB H1 (Spieler*in)`), keyed by
// registrations.membership_type. Passive registrations have no team → no group.
const CD_GRUPPEN_SPORT_PREFIX = { volleyball: 'VB', basketball: 'BB' }
// Funktionen that map to a ClubDesk group suffix. Anything else (passive
// licence lists, "Andere") gets NO group — never drop someone into a player
// group they don't belong to. 'Guest' is the guest-registration funktion (the
// signup form's "Gast (Guest)" option) → its own '<group> (Guest)' token, same
// as the guest-roster consistency check ([[CD_GUEST_FUNKTION]]).
const CD_GRUPPEN_FUNKTIONEN = ['Spieler*in', 'Trainer*in', 'Guest']

// ClubDesk Funktion for a guest player (member_teams.guest_level > 0). A guest
// sits in the team's '<group> (Guest)' subgroup instead of '(Spieler*in)' — same
// group, different Funktion — so the consistency check can verify guests are
// marked as such in the register. Must match the ClubDesk Funktion value
// character-for-character (capital G, English — user 2026-07-15). Applies to VB
// and BB alike (the sport lives in clubdesk_group, e.g. 'VB H2' / 'BB HU14', not
// in the Funktion). If ClubDesk's actual value differs (casing/spelling), change
// it here only.
const CD_GUEST_FUNKTION = 'Guest'

// Derive the ClubDesk Gruppen cell from an approved registration: one group per
// team, `<VB|BB> <team> (<funktion>)`, PLUS the officials groups the person's
// licence puts them in (user 2026-07-06): a VB Schreiber → "VB Schreiber:innen",
// a VB Schiedsrichter → "VB Schiedsrichter:innen", a BB referee → "Schiedsrichter
// BB". Returns '' when nothing resolves — empty is safe on a CREATE row. Note:
// Gruppen import is a no-op (proven), so this cell is assignment DOCUMENTATION;
// the actual membership is set manually / by the group-batch tool.
export function deriveGruppen(reg) {
  if (!reg) return ''
  const prefix = CD_GRUPPEN_SPORT_PREFIX[String(reg.membership_type || '').trim().toLowerCase()]
  const groups = []
  const funktion = String(reg.rolle || '').trim()
  if (prefix && CD_GRUPPEN_FUNKTIONEN.includes(funktion)) {
    for (const t of String(reg.team || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      groups.push(`${prefix} ${t} (${funktion})`)
    }
  }
  // VB scorers go in the "VB Schreiber*innen" group (user 2026-07-07, exact
  // ClubDesk group name). Referees are NOT grouped here — they are marked by
  // the Schiedsrichter Ja/Nein field instead (deriveSchiedsrichter).
  const lic = String(reg.lizenz || '').toLowerCase()
  if (prefix === 'VB' && lic.includes('schreiber')) groups.push('VB Schreiber*innen')
  return groups.join(', ')
}

// Derive the ClubDesk Status for a NEW contact (per user rule 2026-07-05:
// "active for new registrations, active if wiedisync_active true"): a fresh
// approved registration makes an Aktivmitglied (Passivmitglied when the
// registration is the passive path); without a registration, only a member the
// app considers active (wiedisync_active) gets Aktivmitglied. Everything else
// stays empty → ClubDesk's default ("Kein Mitglied"), never guessed.
/**
 * The value an UPDATE row should carry for one of the three register cells
 * (see CD_REGISTER_FIELDS).
 *
 * Precedence, in one place so Status / Eintritt / Austritt cannot drift apart:
 *
 *   1. wiedisync's own value — but ONLY when the member's pending push actually
 *      names this field. `changed` is the set /up builds from
 *      clubdesk_push_changes. This is the entire licence to overwrite the legal
 *      register, and it is scoped to the one field somebody deliberately edited.
 *   2. ClubDesk's own cell, echoed back verbatim (a proven no-op on import) —
 *      so an unrelated push, or a wiedisync value that is empty, can never
 *      blank or rewrite the register.
 *   3. `fallback` — the derivation that predates the columns (the registration
 *      submission date for Eintritt, deriveStatus for a new contact). Only
 *      reached when BOTH sides are empty.
 *
 * `wiedi` is pre-formatted by the caller (dates as dd.mm.yyyy), because the
 * comparison that matters here is "did somebody change this", not the shape.
 */
export function registerCell(field, { changed, wiedi, clubdesk, fallback = '' }) {
  const own = String(wiedi ?? '').trim()
  if (changed?.has(field) && own) return own
  const cd = String(clubdesk ?? '').trim()
  if (cd) return cd
  return own || String(fallback ?? '').trim()
}

/**
 * The fields a member's pending push explicitly names, as a Set.
 *
 * `clubdesk_push_changes` is jsonb, so knex hands it back already parsed on
 * some paths and as a string on others (raw queries) — both shapes are handled,
 * and anything unparseable degrades to an EMPTY set. Empty is the safe default:
 * it means "echo ClubDesk", never "overwrite the register".
 */
export function changedPushFields(raw) {
  let list = []
  try {
    list = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : [])
  } catch { list = [] }
  return new Set(
    (Array.isArray(list) ? list : [])
      .map((c) => (c && typeof c === 'object' ? c.field : null))
      .filter(Boolean),
  )
}

// ⚠⚠ THE WHITELIST IS A SECURITY BOUNDARY, not a convenience. `field` reaches
// this code from a database row that a SQL detection pass wrote, but the accept
// path turns it into a column name — so it is validated against this map and
// never interpolated. A `field` that is not a key here is refused outright, and
// that also makes the map the single place that says which columns the register
// is even allowed to influence.
//
// The `type` drives coercion, because everything is stored as text in the
// proposal (one column has to hold a date, a boolean and a name). Exported so
// the whitelist itself is unit-tested rather than trusted.
export const PROPOSAL_COLUMNS = {
  birthdate: 'date',
  adresse: 'text',
  plz: 'text',
  ort: 'text',
  phone: 'text',
  js_id: 'text',
  // ⚠ NOT 'text'. members.sex stores 'm'/'f' and has NO CHECK constraint, while
  // the `conflict` rule stages ClubDesk's own German cell — so a raw write would
  // not fail loudly, it would quietly put 'männlich' in the column the whole
  // gender pipeline reads (fees, the join-team picker, the licence exports).
  sex: 'sex',
  anrede: 'text',
  // ⚠ Writing `nationalitaet` is correct despite the column being
  // trigger-derived: members_sync_nationality() resolves a written display name
  // back to nationalitaet_codes and re-canonicalises the name. Writing the CODE
  // column instead would be the mistake.
  nationalitaet: 'text',
  ahv_nummer: 'text',
  // ⚠⚠ `email` is the member's LOGIN identity, not just a contact cell.
  // Accepting ClubDesk's address changes where that person signs in, so it gets
  // its own coercion (a value that is not an address must never reach the
  // column) and the UI warns on the row and in the bulk confirm. It is here at
  // all because the `conflict` rule (migration 338) made email decidable: before
  // it, an email disagreement could only ever be answered "keep ours".
  email: 'email',
  // Was excluded from the down-sync entirely until now — import-clubdesk-csv.mjs
  // documents why: "a member who deletes their IBAN would have it resurrected
  // every sync... needs a tombstone before importing". proposals_refused_uq IS
  // that tombstone, so the column can finally be offered.
  iban: 'iban',
  // ⚠ Both store a CANONICAL form behind a CHECK constraint (an ISO alpha-2
  // code; a code SET like 'JS,B') while the `conflict` rule stages what the
  // admin READS — ClubDesk's German picklist name, its hand-edited cell. Typed
  // so coerceProposalValue inverts the display back to storage instead of
  // writing it verbatim, which is what 500'd every federation accept.
  federation_of_origin: 'federation',
  trainer_licences: 'trainer_licences',
  beitragskategorie: 'text',
  sektion: 'text',
  register_status: 'text',
  eintritt: 'date',
  austritt: 'date',
  referee_vb: 'bool',
  referee_bb: 'bool',
  scorer_vb: 'bool',
  otr1_bb: 'bool',
  otr2_bb: 'bool',
  otn1_bb: 'bool',
  otn2_bb: 'bool',
}

export function coerceProposalValue(field, raw, ctx = {}) {
  const type = PROPOSAL_COLUMNS[field]
  if (!type) return { ok: false }
  const v = String(raw ?? '').trim()
  if (!v) return { ok: false }
  if (type === 'bool') return { ok: v === 'true', value: true }
  // ⚠⚠ TWO vocabularies reach this function, and forgetting the second one is
  // the whole bug class it now guards (2026-08-29). `proposed_value` is written
  // by two different detection passes:
  //   • the SQL rules (import-clubdesk-csv.mjs) stage the STORAGE shape — ISO
  //     dates, 'm'/'f', an ISO federation code;
  //   • the `conflict` rule (migration 338) stages what the ADMIN READS on the
  //     row — ClubDesk's own cell: '18.08.2026', 'männlich', 'Schweiz', 'J+S, B'.
  // Writing the second verbatim is what made every federation accept a 500
  // (members_federation_of_origin_fmt) and every date conflict a silent skip.
  // So each type below accepts BOTH shapes and emits exactly one.
  //
  // Dates: both forms are unambiguous, and neither is guessed. A dotted date is
  // Swiss day-first by definition (CLAUDE.md) and mm.dd never occurs here; the
  // round-trip check rejects 31.02.2026, which has the right shape and is not a
  // date. Anything else is refused rather than coerced — a mis-parsed birthdate
  // flips minor-protection.
  if (type === 'date') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: true, value: v }
    const m = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
    if (!m) return { ok: false }
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
    const d = new Date(`${iso}T00:00:00Z`)
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return { ok: false }
    return { ok: true, value: iso }
  }
  // members.sex is 'm'/'f' with NO CHECK constraint behind it — see the
  // PROPOSAL_COLUMNS note. ClubDesk's Geschlecht cell is the German pair
  // (sexPushLabel writes it, the drift pass compares it), so both go in.
  if (type === 'sex') {
    const s = v.toLowerCase()
    if (s === 'm' || s === 'männlich' || s === 'maennlich') return { ok: true, value: 'm' }
    if (s === 'f' || s === 'weiblich') return { ok: true, value: 'f' }
    return { ok: false }
  }
  // members.federation_of_origin is an ISO alpha-2 code (members_federation_of_
  // origin_fmt); ClubDesk holds the German picklist NAME. `ctx.countryCodes` is
  // the same pair of vocabularies computeClubdeskDrift already resolves through
  // (country_codes + country_name_aliases) — see loadCountryCodeLookup.
  // ⚠ An unresolvable name is REFUSED, not guessed: the proposal stays pending
  // and surfaces as `skipped`, which is a question a human can still answer.
  if (type === 'federation') {
    const u = v.toUpperCase()
    // Retired sentinel (migration 342). Mapped rather than rejected, exactly as
    // normalizeFederation() and registration-duplicates.js do: a pre-342 row
    // decided today must not 500 under a human's finger. Nothing stages it any
    // more — import-clubdesk-csv.mjs stopped emitting it the same day.
    if (u === 'NONE') return { ok: true, value: 'CH' }
    if (/^[A-Z]{2}$/.test(u)) return { ok: true, value: u }
    const code = ctx.countryCodes instanceof Map ? ctx.countryCodes.get(v.toLowerCase()) : null
    return code ? { ok: true, value: code } : { ok: false }
  }
  // members.trainer_licences is a code SET ('JS,B') under members_trainer_
  // licences_fmt; ClubDesk's cell is hand-edited free text ('J+S, B', 'js b',
  // 'Trainer 2'). parseTrainerLicenceCell is the inverse the drift comparison
  // already runs BOTH sides through, and it swallows a stored code list too, so
  // one call covers both vocabularies. '' (nothing recognised) → refused.
  if (type === 'trainer_licences') {
    const codes = parseTrainerLicenceCell(v)
    return codes ? { ok: true, value: codes } : { ok: false }
  }
  // ⚠ The login address. A register cell that is not an address (ClubDesk holds
  // plenty of "-", "keine", a bare name) must never land in the column that
  // decides where a member signs in — reject rather than coerce, exactly as the
  // date branch does. Lower-cased because that is how every lookup reads it
  // (driftLower, the auth match, the suppression list).
  if (type === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return { ok: false }
    return { ok: true, value: v.toLowerCase() }
  }
  // Stored space-stripped and upper-case (verified against prod: every row is
  // `CH…` with no separators), which is also the form the drift comparison
  // normalises to — so accepting one cannot re-open the same conflict.
  if (type === 'iban') {
    const norm = v.replace(/\s+/g, '').toUpperCase()
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(norm)) return { ok: false }
    return { ok: true, value: norm }
  }
  return { ok: true, value: v }
}

export function deriveStatus(reg, member) {
  if (reg) {
    return String(reg.membership_type || '').trim().toLowerCase() === 'passive'
      ? 'Passivmitglied' : 'Aktivmitglied'
  }
  return member?.wiedisync_active === true ? 'Aktivmitglied' : ''
}

// Derive the ClubDesk "Offiziellen Lizenz" cell from the member's licence
// booleans (VB flags authoritative from Volleymanager, BB from ClubDesk).
// ClubDesk's picklist (user-revised 2026-07-06): VB SR / VB SC for volleyball,
// OTR1 / OTR2 / OTN / Keine / Sammelt Unterschriften for basketball.
//   • VB referee → "VB SR"  (a referee is also a Schreiber — SR is the superset)
//   • VB scorer  → "VB SC"
//   • BB OTR1/OTR2/OTN → same
//   • none → empty (never guessed, ClubDesk stays unset)
// Cross-sport dual holders can't happen at create time (one registration = one
// sport) — first match in this order wins.
export function deriveOffiziellenLizenz(m) {
  // VB referees are marked by the separate Schiedsrichter Ja/Nein field now
  // (user 2026-07-07). Offiziellen Lizenz carries the scorer/table-officials
  // licence: a VB referee is AUTOMATICALLY a scorer (user 2026-07-07), so
  // scorer_vb OR referee_vb → VB SC. BB officials by level. Nothing → empty.
  if (m?.scorer_vb === true || m?.referee_vb === true) return 'VB SC'
  // ⚠ HIGHEST RUNG FIRST. wiedisync models the rungs as independent booleans and
  // an upgraded official keeps the lower one — 43 members hold otr1_bb AND
  // otr2_bb (measured on prod 2026-08-05), which is correct: Basketplan records
  // both `otr1_since` and `otr2_since` for them. ClubDesk's picklist is
  // single-valued, so this has to CHOOSE, and choosing the lower rung would
  // report a qualified OTR2 official as an OTR1. Until 2026-08-05 the order was
  // otr1 → otr2 and did exactly that; it was latent only because every one of
  // those 43 is already linked, and UPDATE rows never carry this column
  // (see CD_PUSH_HEADERS) — so only a CREATE could have shipped the downgrade.
  // If this column is ever added to the UPDATE set, this order is what stops it
  // rewriting 43 correct OTR2 cells.
  if (m?.otr2_bb === true) return 'OTR2'
  if (m?.otr1_bb === true) return 'OTR1'
  // OTN gained levels 2026-07-25: Basketplan has always held "OTN 1 seit dem" /
  // "OTN 2 seit dem" as separate fields (migration 228), and the user added
  // matching OTN1/OTN2 options to the ClubDesk picklist, so the precise level can
  // finally be pushed instead of being flattened to "OTN".
  //
  // The coarse `otn_bb` fallback that used to sit under these two was dropped by
  // migration 303, once every one of its 8 holders had been confirmed OTN 2 by
  // the Basketplan import — i.e. once it could no longer be the only true flag
  // for anybody. A member with no level now sends an empty cell, and Basketplan
  // remains the only thing that resolves one.
  if (m?.otn2_bb === true) return 'OTN2'
  if (m?.otn1_bb === true) return 'OTN1'
  return ''
}

// The ClubDesk "Schiedsrichter" Ja/Nein field (user 2026-07-07): Ja when the
// member holds a referee licence (VB or BB), else Nein. Referees are marked
// here instead of via a referee group.
export function deriveSchiedsrichter(m) {
  return (m?.referee_vb === true || m?.referee_bb === true) ? 'Ja' : 'Nein'
}

// Derive the ClubDesk Sektion for a NEW contact from the registration's sport:
// volleyball → Volleyball, basketball → Basketball. Passive registrations have
// no sport — the registration approver picks Volleyball/Basketball/KSCW in
// wiedisync (registrations.sektion_choice), so use that; fall back to KSCW when
// unset (a passive member always belongs to the club).
export function deriveSektion(reg) {
  if (!reg) return ''
  const mt = String(reg.membership_type || '').trim().toLowerCase()
  if (mt === 'volleyball') return 'Volleyball'
  if (mt === 'basketball') return 'Basketball'
  // passive (or unknown) → approver's choice, default KSCW
  return String(reg.sektion_choice || '').trim() || 'KSCW'
}

// Signup-form category → ClubDesk Beitragskategorie picklist name. The form's
// names only partially match ClubDesk's configured categories (e.g. the form
// says "BB Lernende/Studierende", ClubDesk has "BB Student/Lehrling"; "VB
// Turnier KWI" has no ClubDesk category yet). ClubDesk's import treatment of
// an UNKNOWN category value is unvalidated — fill this map as the
// ClubDesk-side names are confirmed. Unmapped values pass through verbatim
// (visible in the dry-run preview before any commit).
// BB youth decided 2026-07-06 (user): the two ClubDesk categories are
// "BB Minis Turnier" (U12 and under) and "BB Jugend Meisterschaft"
// (older youth) — the form now submits those names directly; the two
// entries below only translate LEGACY rows captured under the pre-2026-07-06
// form values.
export const CD_KATEGORIE_MAP = {
  'BB Junior:innen': 'BB Jugend Meisterschaft',
  'BB Minis': 'BB Minis Turnier',
  // 'VB Student*in Meisterschaft': '…',
  // 'BB Lernende/Studierende': '…',
  // 'VB Turnier KWI': '…',
}
export function mapKategorie(v) {
  const k = String(v ?? '').trim()
  return Object.prototype.hasOwnProperty.call(CD_KATEGORIE_MAP, k) ? CD_KATEGORIE_MAP[k] : k
}

// Category → Mitgliederbeitrag (CHF/season), confirmed by the user 2026-07-06:
// VB = published website fees (matched ClubDesk exactly); BB = the ClubDesk
// values; BB youth = the two new age-split categories. ⚠ EVERY BB category rose
// by CHF 10 on 2026-08-10 (user decision, effective season 2026/27 — nothing had
// been invoiced yet), which is why the BB amounts below no longer match the
// ClubDesk export snapshot of July: 510→520, 560→570, 410→420, 460→470,
// 310→320, 210→220. VB is untouched. Keys cover BOTH name families because
// members.beitragskategorie can hold either: signup-form names (registration
// path) or ClubDesk names (the CD-authoritative Kategorie fill in
// import-clubdesk-csv.mjs). Pushed on CREATE rows only — on existing contacts
// Mitgliederbeitrag is a per-person field with manual overrides (e.g.
// "Speziallizenz, einmalig so tief"), never ours to overwrite. The map holds
// the WITH-scorer-licence BASE amount; the CHF 100 no-Schreiber surcharge is
// applied on top by deriveMitgliederbeitrag (user rule 2026-07-06).
export const CD_BEITRAG_MAP = {
  'VB Erwerbstätige': 440,
  'VB Student*in Meisterschaft': 380, 'VB Studenten/Lehrlinge': 380,
  'VB Schüler*in Meisterschaft': 310, 'VB Schüler Meisterschaft': 310,
  'VB Schüler*in Turnier': 210, 'VB Schüler Turnier': 210,
  'VB Turnier KWI': 110, 'VB Schüler*in 1. Jahr': 110,
  'BB Erwerbstätige': 520, 'BB Erwerbstätig': 520,
  'BB Erwerbstätige 1. Liga': 570, 'BB Erwerbstätig 1. Liga': 570,
  'BB Lernende/Studierende': 420, 'BB Student/Lehrling': 420, 'BB Studenten/Lehrlinge': 420,
  'BB Lernende/Studierende 1. Liga': 470, 'BB Student/Lehrling 1. Liga': 470,
  'BB Jugend Meisterschaft': 320, 'BB Junior:innen': 320, 'BB 2 Trainings': 320,
  'BB Minis Turnier': 220, 'BB Minis': 220, 'BB 1 Trainings': 220,
  'Passivmitglied': 40,
  'Gratis': 0,
  // Terminal, non-member bucket (created 2026-07-30). Covers BOTH
  // `Ehemaliges Mitglied` (left the club) and `Kein Mitglied` (sponsors,
  // parents, contacts who were never members) — Status says which, the
  // category says only "owes no Mitgliederbeitrag". Distinct from 'Gratis',
  // which is a MEMBER who owes nothing (coach/staff, migration 262).
  'Kein Beitrag': 0,
}
// The CHF 100 no-licence surcharge (VB: website "Mitgliederbeitrag für aktive
// Mitglieder ohne Schreiberlizenz um CHF 100 erhöht"; BB: user rule 2026-07-06
// replacing the deleted ClubDesk "Offiziellen 100er" field). The map amounts
// are the WITH-licence base; +100 for a member with the duty but no licence.
// VB confirmed against the export (Erwerbstätige 440/540, Student 380/480,
// Schüler Meisterschaft 310/410, Schüler Turnier 210/310). BB pairs were
// confirmed the same way at the pre-2026-08-10 bases and moved up with the
// CHF 10 increase (Erwerbstätig 520/620, 1.Liga 570/670, Student 420/520,
// Jugend 320/420, Minis 220/320) — the surcharge itself did not change. Duty
// applies from U16 AND ABOVE ONLY (user 2026-07-06) — younger players never pay it.
//
// ADULT categories are inherently U16+ → surcharge on a missing licence
// regardless of birthdate. Both ClubDesk name families listed.
const SURCHARGE_ADULT = new Set([
  'VB Erwerbstätige',
  'VB Student*in Meisterschaft', 'VB Studenten/Lehrlinge',
  'BB Erwerbstätige', 'BB Erwerbstätig',
  'BB Erwerbstätige 1. Liga', 'BB Erwerbstätig 1. Liga',
  'BB Lernende/Studierende', 'BB Student/Lehrling', 'BB Studenten/Lehrlinge',
  'BB Lernende/Studierende 1. Liga', 'BB Student/Lehrling 1. Liga',
])
// YOUTH categories are mixed-age → surcharge ONLY when the member is U16+ by
// birthdate (isU16Plus). U14/Minis players never pay it. The intro tiers
// "VB Turnier KWI" / "VB Schüler*in 1. Jahr" and Passiv/Gratis are in NEITHER
// set → never surcharged.
const SURCHARGE_YOUTH = new Set([
  'VB Schüler*in Meisterschaft', 'VB Schüler Meisterschaft',
  'VB Schüler*in Turnier', 'VB Schüler Turnier',
  'BB Jugend Meisterschaft', 'BB Junior:innen', 'BB 2 Trainings',
  'BB Minis Turnier', 'BB Minis', 'BB 1 Trainings',
])
// U16-and-above age gate (user 2026-07-06: surcharge only for U16+). "U16" is a
// birth-year band, so approximate by age — a player who turns at least 15 in
// the current calendar year (birthYear <= thisYear - 15) counts as U16+.
// Unknown birthdate → null (caller treats youth as NOT U16+, so a young member
// is never over-charged without knowing the age).
export function isU16Plus(member, refYear = new Date().getFullYear()) {
  const bd = member?.birthdate
  if (!bd) return null
  const iso = bd instanceof Date ? bd.toISOString().slice(0, 10) : String(bd)
  const y = Number(iso.slice(0, 4))
  if (!Number.isInteger(y) || y < 1900) return null
  return (refYear - y) >= 15
}

/** CHF added when a member owes scorer/table duty but holds no licence. */
export const NO_LICENCE_SURCHARGE = 100
/** CHF taken off a pure guest's category fee — a guest does no scorer duty. */
export const GUEST_DISCOUNT = 110

/**
 * Coerce a per-member override cell to a non-negative number, or null when the
 * member simply has no override.
 *
 * ⚠ Postgres `numeric` arrives as a STRING through pg, so `typeof v === 'number'`
 * would read every override as absent and silently fall back to the derived
 * amount — the same trap `opts.baseOverride` documents below. NULL, undefined
 * and '' all mean "not set"; 0 is a real, deliberate value (a waived surcharge).
 */
function overrideNum(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * The club's fee model, itemised: category base ± the two adjustments. Returns
 * null when there is no base to work from — an unknown category is never given
 * a guessed amount.
 *
 * `opts.baseOverride` lets a caller supply the base from elsewhere (the
 * per-season `finance_dues_rates` schedule the native dues run bills from)
 * while the adjustment RULES stay codified here. Without it the dues run and
 * the ClubDesk push would be two fee engines that silently disagree — the flat
 * schedule alone under-bills every member who owes the surcharge.
 * A category outside the map is billable via the override, but never
 * surcharged: the surcharge sets are keyed by the known category names.
 *
 * PER-MEMBER overrides (migrations 299/300) sit one level above all of that,
 * because they exist precisely for the cases a category cannot express:
 *   • `member.fee_base_override`      beats the schedule AND the map
 *   • `member.fee_surcharge_override` BOOLEAN: true charges the CHF 100, false
 *                                     waives it, null applies the rule
 *   • `member.fee_discount` (CHF) or `fee_discount_pct` (% of what is owed)
 *                                     apply when the caller passes no per-run
 *                                     discount of its own
 * A member row that predates the migrations — or a hand-built object in a test —
 * simply has none of those keys and behaves exactly as before.
 */
export function feeBreakdown(kategorie, member = null, opts = {}) {
  const k = String(kategorie ?? '').trim()
  // Postgres `numeric` arrives as a string through pg — coerce, don't test typeof.
  const raw = opts?.baseOverride
  const override = raw === null || raw === undefined || raw === '' ? null : Number(raw)
  const memberBase = overrideNum(member?.fee_base_override)
  const base = memberBase !== null ? memberBase
    : override !== null && Number.isFinite(override) ? override
    : Object.prototype.hasOwnProperty.call(CD_BEITRAG_MAP, k) ? CD_BEITRAG_MAP[k]
    : null
  if (base === null) return null

  // Boolean since migration 300: true charges the CHF 100, false waives it,
  // null/absent applies the rule below. `=== true` / `=== false` on purpose —
  // undefined must not read as "waive".
  const memberSurcharge = member?.fee_surcharge_override === true ? NO_LICENCE_SURCHARGE
    : member?.fee_surcharge_override === false ? 0
    : null
  // The treasurer's standing reduction. A discount named by the CALLER (the
  // per-run `discounts` map) wins: it is the decision being made right now for
  // this one run, and it must be able to differ from the member's standing one.
  // It cannot, however, silently *cancel* the standing discount by passing 0 —
  // "no per-run discount" is the default every caller sends.
  const runDiscount = Number(opts?.discount)
  const feeOpts = Number.isFinite(runDiscount) && runDiscount > 0
    ? { discount: runDiscount }
    : {
        discount: overrideNum(member?.fee_discount) ?? 0,
        discountPct: overrideNum(member?.fee_discount_pct) ?? 0,
      }

  // A guest (guest on a team, core on none) pays the base minus CHF 110,
  // floored at 0, and NEVER the no-Schreiber surcharge (user 2026-07-15) —
  // unless a per-member override names one explicitly, which is a decision a
  // human made about this person and outranks the rule.
  if (opts?.isGuest === true) {
    const gd = Math.min(Math.max(base, 0), GUEST_DISCOUNT)
    const surcharge = memberSurcharge ?? 0
    return withDiscount(
      { category: k, base, surcharge, guest_discount: gd, amount: base + surcharge - gd },
      feeOpts,
    )
  }
  // member===null (flags unavailable) → base only, a safe default. Adult
  // category → surcharge on missing licence; youth category → surcharge only
  // when the member is U16+ (isU16Plus() === true).
  let surcharge = 0
  if (memberSurcharge !== null) {
    surcharge = memberSurcharge
  } else if (member) {
    const isVb = k.startsWith('VB ')
    const hasLicence = isVb
      ? member.scorer_vb === true
      : (member.otr1_bb === true || member.otr2_bb === true
         || member.otn1_bb === true || member.otn2_bb === true)
    const eligible = SURCHARGE_ADULT.has(k) || (SURCHARGE_YOUTH.has(k) && isU16Plus(member) === true)
    if (eligible && !hasLicence) surcharge = NO_LICENCE_SURCHARGE
  }
  return withDiscount({ category: k, base, surcharge, guest_discount: 0, amount: base + surcharge }, feeOpts)
}

/** The `members` columns feeBreakdown() reads for the per-member overrides.
 *  Every query that feeds it a member row must select these — omit them and the
 *  engine silently bills the derived amount instead of the override. */
export const FEE_OVERRIDE_FIELDS = [
  'fee_base_override', 'fee_surcharge_override',
  'fee_discount', 'fee_discount_pct', 'fee_discount_reason',
]

/**
 * Apply the treasurer's on-demand reduction to a computed fee.
 *
 * Two units: `opts.discount` is CHF, `opts.discountPct` is a percentage OF WHAT
 * IS OWED at this point (base + surcharge − guest reduction). CHF wins if both
 * arrive — the DB CHECK members_fee_discount_one_unit stops a member row from
 * holding both, so in practice that only happens when a dues run names a CHF
 * discount over a member's standing percentage, which is the intended override.
 *
 * Capped at what is owed: a discount may take a bill to exactly zero (the issue
 * path then skips it as a zero-rate row) but never below, which would mint an
 * invoice that owes the MEMBER money and a QR bill for a negative amount.
 * Non-numeric, zero and negative requests are simply no discount — a typo in the
 * preview must not silently become a credit.
 */
function withDiscount(fee, opts) {
  const round2 = (n) => Math.round(n * 100) / 100
  const owed = Math.max(0, round2(fee.amount))
  const rawChf = Number(opts?.discount)
  const rawPct = Number(opts?.discountPct)
  const wanted = Number.isFinite(rawChf) && rawChf > 0
    ? round2(rawChf)
    : Number.isFinite(rawPct) && rawPct > 0
      // A percentage over 100 is capped by the `owed` floor below anyway, but
      // clamp here too so the reported discount stays a believable figure.
      ? round2(owed * Math.min(rawPct, 100) / 100)
      : 0
  if (!wanted) return { ...fee, discount: 0, amount: round2(fee.amount) }
  const discount = Math.min(wanted, owed)
  return { ...fee, discount, amount: round2(fee.amount - discount) }
}

export function deriveMitgliederbeitrag(kategorie, member = null, opts = {}) {
  // The ClubDesk push always bills the codified map — no baseOverride here. The
  // member's OWN overrides (migration 299) do apply: they are the club's answer
  // to "this person pays something else", and a new ClubDesk contact created at
  // the derived amount would immediately need the same hand-correction the
  // override exists to remove.
  const b = feeBreakdown(kategorie, member, { isGuest: opts?.isGuest === true })
  return b ? String(b.amount) : '' // unknown → empty, never guessed
}

// Resolve which of the given members are GUESTS this season: at least one guest
// roster (guest_level > 0) and NO core roster (guest_level = 0). A pure guest
// gets the reduced Mitgliederbeitrag (deriveMitgliederbeitrag isGuest); someone
// core on any team is a full member. Returns a Set of member ids. Used by the
// CREATE-push path so a new guest contact lands in ClubDesk already billed the
// guest rate (Mitgliederbeitrag is CREATE-only — never touched on updates).
export async function guestMemberIdSet(database, memberIds, season) {
  const ids = [...new Set((memberIds || []).map(Number).filter(Number.isInteger))]
  if (!ids.length) return new Set()
  const rows = await database('member_teams')
    .whereIn('member', ids).andWhere('season', season)
    .groupBy('member')
    .select('member')
    .select(database.raw('bool_or(COALESCE(guest_level, 0) > 0) AS any_guest'))
    .select(database.raw('bool_or(COALESCE(guest_level, 0) = 0) AS any_core'))
  const out = new Set()
  for (const r of rows) if (r.any_guest && !r.any_core) out.add(Number(r.member))
  return out
}

/**
 * Who owes CHF 0 by RULE rather than by fee category (user 2026-08-13).
 *
 *   honorary  register_status 'Ehrenmitglied'
 *   vorstand  the `vorstand` app role
 *   coach     coach of an ACTIVE team
 *
 * ⚠ A TEAM RESPONSIBLE IS NOT A COACH (user 2026-08-13) — teams_responsibles is
 * deliberately not consulted here. On prod that is the difference between 2 and
 * 6 members: Czuk, Gerbino, Müller and Wanner are TRs of the team they play on
 * and are correctly billed today.
 * ⚠ COACHING WINS over playing: a player-coach is free even though they hold a
 * paid player category.
 *
 * ONE definition, two consumers — the Data Health fee check (which reports
 * "should be free but is billed") and the dues run (which waives the bill).
 * Split them and the check would flag members the run then bills anyway.
 *
 * @returns {Promise<Map<number, 'honorary'|'vorstand'|'coach'>>} reason per
 *   member — it travels because it is printed on the invoice's waiver line.
 */
export async function resolveFeeWaivers(database, memberIds = null) {
  const ids = Array.isArray(memberIds)
    ? [...new Set(memberIds.map(Number).filter(Number.isInteger))]
    : null
  if (ids && !ids.length) return new Map()
  const bind = []
  let filter = ''
  if (ids) { filter = 'AND m.id = ANY(?)'; bind.push(ids) }
  const res = await database.raw(`
    SELECT m.id, m.register_status,
           (m.role @> '["vorstand"]'::jsonb) AS is_vorstand,
           EXISTS (
             SELECT 1 FROM teams_coaches j
               JOIN teams t ON t.id = j.teams_id AND t.active
              WHERE j.members_id = m.id
           ) AS is_coach
      FROM members m
     WHERE TRUE ${filter}`, bind)
  const out = new Map()
  for (const r of res.rows) {
    // Fixed precedence so the printed reason is stable for somebody who is two
    // of these at once (an honorary coach reads 'honorary', not whichever the
    // query happened to evaluate first).
    if (r.register_status === 'Ehrenmitglied') out.set(Number(r.id), 'honorary')
    else if (r.is_vorstand === true) out.set(Number(r.id), 'vorstand')
    else if (r.is_coach === true) out.set(Number(r.id), 'coach')
  }
  return out
}

// ClubDesk's Gast checkbox cell (see CD_PUSH_CONTACT_HEADERS). Deliberately
// TOTAL — a non-guest asserts 'Nein' instead of sending an empty cell, so the
// register never has to distinguish "not a guest" from "nobody ever said".
// That also makes the field structurally exempt from the echo-back /
// blank-risk machinery: there is no empty wiedisync value that could blank it.
// Takes the boolean from guestMemberIdSet, never a raw guest_level.
export function gastCell(isGuest) {
  return isGuest === true ? 'Ja' : 'Nein'
}

function fmtBirthdateDDMMYYYY(v) {
  if (!v) return ''
  const iso = (v instanceof Date) ? v.toISOString().slice(0, 10) : String(v)
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : ''
}

// Semicolon-CSV cell: neutralise spreadsheet-formula injection, then quote.
// Leading '+'/'-' followed by a digit, space or '(' is DATA, not a formula —
// the blanket guard used to land a literal apostrophe in ClubDesk's phone
// fields on every committed push ('+41 …; found 2026-07-06 on 10 contacts,
// repaired via the backfill import). '=', '@', tab, CR and '+'/'-' followed by
// anything else (e.g. +HYPERLINK(…)) stay guarded.
function cdCell(val) {
  let s = String(val ?? '')
  if (/^[=@\t\r]/.test(s) || /^[+-](?![\d( ])/.test(s)) s = `'${s}`
  return (s.includes(';') || s.includes('"') || s.includes('\n'))
    ? `"${s.replace(/"/g, '""')}"` : s
}

// Country code → the EXACT German spelling ClubDesk's picklists expect
// (country_codes.name_de_clubdesk, migration 224). Read from Postgres, never
// hardcoded: 196 names in JS would silently rot the day someone edits the
// picklist, and Intl.DisplayNames is NOT interchangeable — 7 CLDR spellings
// differ from ClubDesk's own (GB is "Großbritannien" there, "Vereinigtes
// Königreich" in CLDR), and a non-matching string lands the row in ClubDesk's
// "nicht erkannte" bucket instead of the field. Loaded ONCE per push/drift run
// and threaded through — never per row.
export async function loadCountryPushNames(database) {
  const rows = await database('country_codes').select('code', 'name_de_clubdesk')
  return new Map(rows.map((r) => [String(r.code || '').trim().toUpperCase(), String(r.name_de_clubdesk || '').trim()]))
}

// members.federation_of_origin → the ClubDesk cell. wiedisync stores a CODE
// (ISO alpha-2), ClubDesk a German picklist string, so this is the only place
// the two shapes meet:
//   'IT'   → 'Italien'  (whatever country_codes.name_de_clubdesk says)
//   NULL/'' → ''        (not answered — an empty cell is a no-op on import)
// There is no "Keiner": a member whose first licence is issued here is 'CH' and
// pushes as 'Schweiz' (migration 342 retired the 'NONE' sentinel).
// An unknown code (or a missing map) also yields '' rather than a guessed
// spelling ClubDesk would reject; the caller's echo-back then fills the cell
// with ClubDesk's own value, so we can never blank the register.
export function federationCell(code, countryNames) {
  const v = String(code ?? '').trim().toUpperCase()
  if (!v) return ''
  return (countryNames && countryNames.get(v)) || ''
}

// The INVERSE of federationCell: every German/English country name the two
// systems use → its ISO code, in ONE map. Both vocabularies are needed because
// the name being resolved can come from either side of the sync — ClubDesk's
// picklist spelling (`name_de_clubdesk`, e.g. "Großbritannien") or the club's
// own display spelling (`name_de`/`name_en`) — and `country_name_aliases` then
// fills in everything either side has ever been seen writing.
//
// ⚠ country_codes is loaded FIRST and first spelling wins, so the curated
// column beats an alias row if they ever disagree.
//
// Used by the proposal accept path (coerceProposalValue) to turn the name an
// admin decided on back into the code the column stores. Loaded once per
// request, never per row — the two tables are small and static.
export async function loadCountryCodeLookup(database) {
  const map = new Map()
  const add = (name, code) => {
    const n = String(name ?? '').trim().toLowerCase()
    const c = String(code ?? '').trim().toUpperCase()
    if (n && /^[A-Z]{2}$/.test(c) && !map.has(n)) map.set(n, c)
  }
  for (const r of await database('country_codes').select('code', 'name_de', 'name_en', 'name_de_clubdesk')) {
    add(r.name_de_clubdesk, r.code)
    add(r.name_de, r.code)
    add(r.name_en, r.code)
  }
  try {
    for (const a of await database('country_name_aliases').select('alias', 'code')) add(a.alias, a.code)
  } catch { /* no alias table → the curated names still resolve, as before */ }
  return map
}

// members.nationalitaet_codes → the ClubDesk cell, same picklist spellings as
// federationCell. ClubDesk's field is single-valued and the push sends
// members.nationalitaet (the FIRST code, mirrored by migration 223's trigger);
// this renders the whole list because it feeds the admin-facing change preview,
// where a second-nationality edit would otherwise look like no change at all.
export function nationalityCell(codes, countryNames) {
  const list = parseCodeList(codes)
  if (!list.length) return String(codes ?? '').trim()
  return list.map((c) => (countryNames && countryNames.get(c)) || c).join(', ')
}

// members.trainer_licences → the ClubDesk cell, and back.
//
// wiedisync stores an ordered code list ("JS,C,B,A,T1,T2,T3", migrations 274 +
// 281); ClubDesk's "Trainer Lizenz" is free text read by board members, so it
// gets the wording the club itself used: J+S for the Jugend+Sport track, the
// bare rung letter for Swiss Volley's ladder, and "Trainer n" for Swiss
// Basketball's — which is exactly how the basketball coaches' cells already read.
//   'JS,B' → 'J+S, B'   'JS' → 'J+S'   'A' → 'A'   'T2' → 'Trainer 2'   '' → ''
// Unknown codes are dropped rather than guessed at, and an empty result lets
// the caller's echo-back send ClubDesk's own cell — so this can never blank the
// register.
//
// ⚠ The volleyball and basketball rungs are NOT interchangeable — 'T2' is not a
// synonym for 'B'. Nothing here may map one onto the other.
const TRAINER_LICENCE_CD_LABELS = {
  JS: 'J+S', C: 'C', B: 'B', A: 'A',
  T1: 'Trainer 1', T2: 'Trainer 2', T3: 'Trainer 3',
}
const TRAINER_LICENCE_RANK = { JS: 0, C: 1, B: 2, A: 3, T1: 4, T2: 5, T3: 6 }

export function trainerLicenceCell(codes) {
  return parseTrainerLicenceCodes(codes).map((c) => TRAINER_LICENCE_CD_LABELS[c]).join(', ')
}

/**
 * Parse a stored code list into canonical order. Mirrors
 * `parseTrainerLicences()` in src/utils/trainerLicences.ts — ⚠ keep the two in
 * step; the frontend helper cannot be imported here (different build).
 */
export function parseTrainerLicenceCodes(value) {
  const seen = []
  for (const raw of String(value ?? '').split(',')) {
    const code = raw.trim().toUpperCase()
    if (code in TRAINER_LICENCE_RANK && !seen.includes(code)) seen.push(code)
  }
  return seen.sort((a, b) => TRAINER_LICENCE_RANK[a] - TRAINER_LICENCE_RANK[b])
}

/**
 * ClubDesk's free-text cell → wiedisync's code list, for the down-sync and the
 * drift comparison. Tolerant on purpose: the column is hand-editable, so it has
 * to survive "J+S, B", "J+S/B", "js b", "Trainer B", "A, B" and stray
 * whitespace. Anything it cannot recognise yields '' rather than a guess —
 * migration 274's CHECK would reject a bad code and abort the whole import.
 *
 * ⚠ Order matters in the token scan: 'J+S' must be tried before the bare
 * letters, or the 'S' in "J+S" is never reached and the '+' splits it into
 * junk. Bare-letter matching is anchored to whole tokens for the same reason —
 * a substring scan would find a 'B' inside "Basketball".
 *
 * ⚠ The basketball rungs must ALSO be lifted before tokenizing. "Trainer 2" is
 * two tokens, and the word is on the skip list precisely so "Trainer B" yields
 * B — so by the time the loop runs, the link between "Trainer" and "2" is gone
 * and the digit is junk. Lifting it to a 'T2' token first keeps "Trainer B"
 * working (no digit → no lift → still TRAINER + B) while "Trainer 2+" resolves.
 * The trailing '+' the club types on "Trainer 2+" is dropped: it is shorthand in
 * a free-text cell, not a fourth rung (user 2026-08-05).
 */
export function parseTrainerLicenceCell(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  // Lift every J+S spelling out FIRST and replace it with a bare token: the
  // '+' would otherwise be eaten as a separator and the 'S' left as junk.
  // Then the basketball rungs, for the reason in the block comment above.
  const lifted = raw
    .replace(/j\s*\+?\s*s|jugend\s*\+?\s*sport/gi, ' JS ')
    .replace(/trainer\s*\.?\s*([123])/gi, ' T$1 ')
  const found = []
  // Split on every separator the hand-edited cell might use. Whole tokens only
  // -- a substring scan would find a 'B' inside 'Basketball'.
  for (const tok of lifted.split(/[\s,;/|+]+/)) {
    const t = tok.trim().toUpperCase()
    if (!t) continue
    // 'Trainer B' / 'Stufe C' arrive as two tokens; the word carries no code.
    if (t === 'TRAINER' || t === 'STUFE' || t === 'LEITER') continue
    if ((t === 'JS' || t in TRAINER_LICENCE_RANK) && !found.includes(t)) found.push(t)
  }
  return found.sort((a, b) => TRAINER_LICENCE_RANK[a] - TRAINER_LICENCE_RANK[b]).join(',')
}

/**
 * Reader-facing rendering for the admin change email, in the recipient's own
 * language — the same split federations.js makes: `trainerLicenceCell` writes
 * ClubDesk's German cell, this writes what a human reads.
 *
 * ⚠ 'J+S' is NOT translated in any locale: Jugend+Sport is a federal programme
 * name, i.e. a brand, and an "F+S"/"G+S" would be unrecognisable. Only the
 * ladder rungs take the local word for "coach". Mirrors the `auth` i18n keys
 * trainerLicence{JS,C,B,A,T1,T2,T3} in the frontend — keep the two in step.
 */
const TRAINER_LICENCE_DISPLAY = {
  de: { JS: 'J+S', C: 'Trainer C', B: 'Trainer B', A: 'Trainer A', T1: 'Trainer 1', T2: 'Trainer 2', T3: 'Trainer 3' },
  gsw: { JS: 'J+S', C: 'Trainer C', B: 'Trainer B', A: 'Trainer A', T1: 'Trainer 1', T2: 'Trainer 2', T3: 'Trainer 3' },
  en: { JS: 'J+S', C: 'Trainer C', B: 'Trainer B', A: 'Trainer A', T1: 'Trainer 1', T2: 'Trainer 2', T3: 'Trainer 3' },
  fr: { JS: 'J+S', C: 'Entraîneur C', B: 'Entraîneur B', A: 'Entraîneur A', T1: 'Entraîneur 1', T2: 'Entraîneur 2', T3: 'Entraîneur 3' },
  it: { JS: 'J+S', C: 'Allenatore C', B: 'Allenatore B', A: 'Allenatore A', T1: 'Allenatore 1', T2: 'Allenatore 2', T3: 'Allenatore 3' },
}

export function trainerLicenceDisplay(codes, loc) {
  const map = TRAINER_LICENCE_DISPLAY[loc] || TRAINER_LICENCE_DISPLAY.en
  return parseTrainerLicenceCodes(codes).map((c) => map[c]).join(', ')
}

// The Lizenzart cell carries the PLAYING licence type (RLL/JLL/Senior/U n/…).
// Basketplan's licence list also files pure officials under a category —
// 'Offizielle/r' — but that is an OFFICIALS licence, which ClubDesk models in
// its own Offiziellen Lizenz field (deriveOffiziellenLizenz: VB SC / OTR/OTN
// levels); pushing it as Lizenzart would misfile the qualification as a playing
// licence. Suppressed here — an official-only member sends an empty cell (a
// harmless no-op on import). members.licence_category keeps the value.
export function lizenzartCell(licenceCategory) {
  const v = String(licenceCategory || '').trim()
  return v === 'Offizielle/r' ? '' : v
}

export function buildPushCsv(members, { create = false, countryNames = null } = {}) {
  // Column order MUST match CD_PUSH_HEADERS (+ create extras). Create rows also
  // carry Beitragskategorie + Eintritt + Gruppen + Status (see
  // CD_PUSH_CREATE_HEADERS); m.eintritt, m.gruppen and m.cd_status are resolved
  // by /up from the person's approved registration (+ wiedisync_active for the
  // status fallback). anrede/nationalitaet/ahv_nummer are echo-resolved by /up
  // for UPDATE rows (empty → ClubDesk's own value) — see CD_PUSH_HEADERS.
  const headers = create ? CD_PUSH_CREATE_HEADERS : CD_PUSH_HEADERS
  const rows = members.map((m) => {
    // Outgoing repair: push the CANONICAL form (normalize.js) so every commit
    // also standardizes ClubDesk's copy (INFRA.md → "Contact-data normalization
    // rule"). Values that don't normalize (legacy 9-digit numbers, mangled
    // cells) pass through raw — the push must never blank or reshape a value it
    // can't parse.
    const phoneOut = normVal(normalizePhone, m.phone)
    const ibanOut = normVal(normalizeIban, m.iban)
    const ahvOut = normVal(normalizeAhv, m.ahv_nummer)
    const emailOut = normVal(normalizeEmail, m.email)
    // Shared contact cells — order mirrors CD_PUSH_CONTACT_HEADERS exactly.
    const contactCells = [
      // phoneOut falls back to ClubDesk's own `Telefon Privat`, stashed by /up
      // when wiedisync holds no number — the same one-hop echo Federation of
      // Origin uses, and for the same reason (the normalizer must not reshape a
      // value we are only echoing). Creates never have a mirror to fall back to.
      emailOut, phoneOut || String(m.phone_cd || '').trim(), m.adresse, m.plz, m.ort,
      fmtBirthdateDDMMYYYY(m.birthdate),
      m.sex === 'm' ? 'männlich' : m.sex === 'f' ? 'weiblich' : '',
      // /up pre-resolves m.iban / m.anrede / m.nationalitaet / m.ahv_nummer to
      // ClubDesk's own value when wiedisync's is empty (UPDATE rows only — see
      // CD_PUSH_CONTACT_HEADERS). Creates push their own values (a new contact
      // has no ClubDesk value to blank).
      ibanOut,
      m.anrede || '', m.nationalitaet || '',
      // Federation of Origin. The echo can't ride on the field itself the way
      // anrede/nationalitaet do (those already hold ClubDesk's own German
      // string): wiedisync stores a CODE, so /up stashes ClubDesk's raw cell in
      // m.federation_of_origin_cd and it is sent verbatim whenever the member
      // has not answered — same "an empty wiedisync field can never blank the
      // register" guarantee, one hop later.
      federationCell(m.federation_of_origin, countryNames) || String(m.federation_of_origin_cd || '').trim(),
      // Trainer Lizenz — same one-hop echo as Federation of Origin above, and
      // for the same reason: wiedisync stores CODES ("JS,B") while ClubDesk's
      // cell holds the human wording ("J+S, B"), so ClubDesk's raw value is
      // stashed in m.trainer_licences_cd rather than assigned back onto the
      // coded column (which a CHECK constraint would reject anyway).
      trainerLicenceCell(m.trainer_licences) || String(m.trainer_licences_cd || '').trim(),
      ahvOut,
      // Wiedisync ID — the member UUID (migration 184), wiedisync-owned: never
      // echoed, never blank. Pre-184 pushes carried the numeric members.id; the
      // down-sync linker accepts both.
      m.uuid ? String(m.uuid) : (m.id != null ? String(m.id) : ''),
      // Gast — resolved by /up from the CURRENT-SEASON roster (m.is_guest, set
      // from guestMemberIdSet for updates and creates alike). Wiedisync-owned:
      // no echo, and 'Nein' rather than an empty cell (see gastCell).
      gastCell(m.is_guest === true),
    ]
    // UPDATE rows are [Id]-keyed and name-less (spike-proven 2026-07-08: the
    // wizard consumes [Id] as the record identity and touches only the columns
    // present — see CD_PUSH_HEADERS). CREATE rows carry the wiedisync name for
    // the brand-new contact. /up guarantees every update member has a
    // clubdesk_id (eligibility filter + stale-link guard).
    const cells = create
      ? [m.first_name, m.last_name, ...contactCells]
      : [String(m.clubdesk_id ?? '').trim(), ...contactCells]
    if (create) {
      cells.push(
        phoneOut, // Telefon Mobil = same as Privat (user: one number → both)
        mapKategorie(m.beitragskategorie),
        // wiedisync's own entry date when it has one (migration 302), else the
        // registration submission date /up resolved.
        fmtBirthdateDDMMYYYY(m.eintritt || m.eintritt_registration),
        m.gruppen || '',
        // An admin-set register status beats the derivation: deriveStatus can
        // only ever say Aktiv-/Passivmitglied, so a contact being created as an
        // Ehrenmitglied would otherwise land in the register as an ordinary one.
        String(m.register_status || '').trim() || m.cd_status || '',
        deriveOffiziellenLizenz(m),
        deriveMitgliederbeitrag(m.beitragskategorie, m, { isGuest: m.is_guest === true }),
        m.cd_sektion || '', // resolved by /up from the registration
        deriveSchiedsrichter(m),
        // Licence number + category from the issuing authority (Volleymanager /
        // Basketplan) — a brand-new contact has no register value to protect.
        String(m.license_nr || '').trim(), lizenzartCell(m.licence_category),
        // Normally empty — a contact being created is joining, not leaving. It
        // is carried anyway so that creating an already-departed person (a
        // historical record being filed) does not silently lose the date.
        fmtBirthdateDDMMYYYY(m.austritt),
      )
    } else {
      // Fill-only billing cells (2026-07-27, see CD_PUSH_HEADERS): ClubDesk's
      // own value always wins — /up stashes it in the `*_cd` mirrors and it is
      // sent back verbatim (a no-op on import), so an update can only ever FILL
      // a cell the register left empty (the CD-side-created-then-linked case).
      // Per-person Mitgliederbeitrag overrides ("Speziallizenz, einmalig so
      // tief") are sacred — they live in the mirror and are never re-derived.
      // Eintritt: the mirror is ClubDesk's export string (dd.mm.yyyy, verified
      // live 2026-07-27) → verbatim; the wiedisync fallback is the registration
      // SUBMISSION date resolved by /up (same rule as the create path).
      // The register triple (migration 302). `changed` is what limits these to
      // the field somebody actually edited — see registerCell / CD_REGISTER_FIELDS.
      const changed = changedPushFields(m.clubdesk_push_changes)
      // ⚠ Beitragskategorie joined the gated set on 2026-08-14. It used to be
      // unconditionally fill-only, which meant a category corrected in wiedisync
      // could NEVER reach the register — and, worse, was silently reverted by the
      // next sync-down, which is ClubDesk-authoritative on this column
      // (`beitragskategorie = COALESCE(cd.categ, …)` in import-clubdesk-csv.mjs).
      // Same narrow gate as the register triple: only a change that NAMES the
      // field wins, so every unrelated push still echoes the register verbatim.
      const kategorieOut = registerCell('beitragskategorie', {
        changed,
        // The MAPPED name — that is the string ClubDesk actually holds
        // (CD_KATEGORIE_MAP), the same reason the drift check compares mapped.
        wiedi: mapKategorie(m.beitragskategorie),
        clubdesk: m.beitragskategorie_cd,
      })
      // ⚠⚠ THE CATEGORY AND THE AMOUNT ARE ONE DECISION, exactly like Status and
      // Austritt below. Sending 'Gratis' while the register keeps CHF 440 would
      // leave the legal register self-contradictory — and the register's own
      // notes show the club reads the two together. So a category change DRAGS
      // the Mitgliederbeitrag cell with it, priced under the NEW category.
      //
      // This does not overrule a hand-set amount: deriveMitgliederbeitrag reads
      // `fee_base_override`, so a member the treasurer re-priced still emits
      // their pinned number (migration 308's 113 rows). If the pin contradicts
      // the new category, the pin wins and the override is what has to change —
      // deliberately, because "the register wins" is the standing rule and a
      // category edit is not authority to discard a treasurer's decision.
      const feeChanged = changed.has('beitragskategorie')
        ? new Set([...changed, 'mitgliederbeitrag'])
        : changed
      const statusOut = registerCell('register_status', {
        changed, wiedi: m.register_status, clubdesk: m.register_status_cd,
      })
      // ⚠ Austritt is gated on the Status cell THIS ROW ACTUALLY SENDS, not on
      // wiedisync's own status. The two are one fact and the register has no
      // constraint tying them, so sending them independently is how ClubDesk
      // ends up with an exit date under an active status — the very pair
      // members_austritt_needs_departed_status (migration 302) refuses here.
      //
      // The case that produces it: a member departed in wiedisync but not yet
      // pushed, flagged for some unrelated field. Status echoes the register's
      // 'Aktivmitglied' (correctly — the departure has not been approved for
      // push), while a naive Austritt cell would fill the register's empty one
      // from the wiedisync value. Then the register reads "active, left on
      // 10.08.2026". Both cells travel together or neither does.
      const austrittOut = DEPARTED_STATUSES.includes(statusOut)
        ? registerCell('austritt', {
          changed, wiedi: fmtBirthdateDDMMYYYY(m.austritt), clubdesk: m.austritt_cd,
        })
        // Not departed per the cell being sent → echo whatever the register has,
        // so this can still never blank an existing date.
        : String(m.austritt_cd || '').trim()
      cells.push(
        kategorieOut,
        // Eintritt: wiedisync's column when it is the thing that changed, else
        // ClubDesk's own cell, else the registration submission date /up
        // resolved (the pre-302 behaviour, unchanged for everybody else).
        registerCell('eintritt', {
          changed,
          wiedi: fmtBirthdateDDMMYYYY(m.eintritt),
          clubdesk: m.eintritt_cd,
          fallback: fmtBirthdateDDMMYYYY(m.eintritt_registration),
        }),
        // Mitgliederbeitrag: fill-only by default, exactly as before — ClubDesk's
        // own amount echoes back and wiedisync's derivation only fills an empty
        // register cell. The ONE licence to overwrite it is the same one the
        // register triple uses: the member's pending push must NAME this field
        // (2026-08-10). Nothing writes that entry automatically — not the hook,
        // not a category edit — so it takes a deliberate act (today: migration
        // 305, correcting 11 basketball rows the register missed at the +10
        // increase). Without the gate this cell cannot be corrected at all;
        // without the gate being *narrow*, a push flagged for an unrelated IBAN
        // change would rewrite 113 per-person amounts the club decided by hand
        // — measured on prod before this shipped, which is why it is not a
        // simple "wiedisync wins".
        registerCell('mitgliederbeitrag', {
          // `feeChanged`, not `changed` — a category change carries the amount.
          changed: feeChanged,
          wiedi: deriveMitgliederbeitrag(m.beitragskategorie, m, { isGuest: m.is_guest === true }),
          clubdesk: m.mitgliederbeitrag_cd,
        }),
        // Lizenznummer / Lizenzart, same fill-only precedence: the register's
        // own cell (stashed by /up) travels verbatim; wiedisync's authority-
        // sourced value goes out only where the register is empty.
        String(m.lizenznummer_cd || '').trim() || String(m.license_nr || '').trim(),
        String(m.lizenzart_cd || '').trim() || lizenzartCell(m.licence_category),
        // Status / Austritt. No derivation fallback on an UPDATE row: a contact
        // that already exists has a status, and inventing one for it is exactly
        // what kept these two off the update set until now.
        statusOut,
        austrittOut,
        // Offiziellen Lizenz (2026-08-14) — fill-only, ClubDesk unconditionally
        // wins. NOT registerCell: see the ⚠ in CD_PUSH_HEADERS. The value is the
        // same derivation the CREATE path uses, so a member's scorer/officials
        // standing reaches the register by exactly one route.
        String(m.offiziellen_lizenz_cd || '').trim() || deriveOffiziellenLizenz(m),
      )
    }
    return cells.map(cdCell).join(';')
  })
  return headers.join(';') + '\n' + rows.join('\n') + '\n'
}

// Member fields the push CSV reads (also the preview fetch set). anrede/
// nationalitaet/ahv_nummer joined the push 2026-07-07, federation_of_origin
// 2026-07-25 (all echo-protected for updates — see CD_PUSH_HEADERS; the
// code→German mapping for the federation happens in buildPushCsv, not here, so
// the column is selected raw). beitragskategorie, birthdate and the licence
// booleans also feed the UPDATE set's fill-only billing cells since 2026-07-27
// (mapKategorie / deriveMitgliederbeitrag — exactly the inputs the CREATE path
// already used); wiedisync_active stays CREATE-only (deriveStatus).
const PUSH_FIELDS = [
  'id', 'uuid', 'first_name', 'last_name', 'email', 'phone', 'adresse', 'plz',
  'ort', 'birthdate', 'sex', 'iban', 'anrede', 'nationalitaet',
  'federation_of_origin', 'trainer_licences', 'ahv_nummer',
  'clubdesk_id', 'clubdesk_push_changes',
  'beitragskategorie', 'wiedisync_active',
  // Club register status + the dates that bracket it (migration 302). The push
  // sends these ONLY when the member's pending change actually names one of
  // them — see CD_REGISTER_FIELDS and registerCell() below.
  'register_status', 'eintritt', 'austritt',
  'scorer_vb', 'referee_vb', 'otr1_bb', 'otr2_bb', 'otn1_bb', 'otn2_bb', 'referee_bb',
  'license_nr', 'licence_category',
  // Per-member fee overrides (migration 299). deriveMitgliederbeitrag reads
  // them off the member row, so leaving them out of the SELECT would push the
  // derived amount for a member the treasurer had explicitly re-priced.
  ...FEE_OVERRIDE_FIELDS,
]

// Escape user-controlled strings before interpolating into the admin email
// body. Without this, a member could submit `<img src=x onerror=…>` as one of
// the changed values and the admin's webmail client would render the payload.
function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildChangesTable(changes, locale = 'de') {
  const labels = FIELD_LABELS[locale] || FIELD_LABELS.de
  const t = T[locale] || T.de
  const rows = changes.map(c => {
    const label = labels[c.field] || c.field
    const oldVal = c.old_value ? escHtml(c.old_value) : '—'
    const newVal = c.new_value ? escHtml(c.new_value) : '—'
    return `<tr>
      <td style="padding:6px 12px;border-bottom:1px solid #334155;color:#e2e8f0;font-size:13px">${escHtml(label)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #334155;color:#ef4444;font-size:13px;text-decoration:line-through">${oldVal}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #334155;color:#22c55e;font-size:13px">${newVal}</td>
    </tr>`
  }).join('')

  return `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #334155;border-radius:8px;overflow:hidden;margin:12px 0">
  <tr>
    <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #334155">${t.field}</th>
    <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #334155">${t.oldValue}</th>
    <th style="padding:8px 12px;text-align:left;font-size:11px;text-transform:uppercase;color:#64748b;border-bottom:1px solid #334155">${t.newValue}</th>
  </tr>
  ${rows}
</table>`
}

export function registerClubdeskUpdate(router, { database, logger, services, getSchema }) {
  const log = logger.child({ endpoint: 'clubdesk-update' })

  // Per-member throttle for the member-facing /clubdesk-update route (2026-07-05
  // audit #12): each call emails a CSV attachment to the admin mailbox + rewrites
  // the push diff, so an unthrottled loop could flood the mailbox and churn the
  // sync-up modal. 5 / hour / member (in-memory — same accepted model as the
  // other kscw-endpoints limiters, safe behind the CF Tunnel).
  const clubdeskUpdateRl = new Map()

  // ── Superadmin gate (ClubDesk member sync is a top-tier, club-wide action) ──
  // Directus admins pass straight through; otherwise the caller must hold the
  // 'superuser' or 'admin' member role. Mirrors finance-ledger.js gate(), tighter.
  async function superGate(req) {
    if (req.accountability?.admin) return true
    const userId = req.accountability?.user
    if (!userId) return false
    const m = await database('members').where('user', userId).first('role')
    if (!m) return false
    const roles = Array.isArray(m.role)
      ? m.role
      : (m.role ? (() => { try { return JSON.parse(m.role) } catch { return [] } })() : [])
    return ['superuser', 'admin'].some((r) => roles.includes(r))
  }

  // Who is doing this. Raw-knex writes bypass Directus's automatic activity +
  // revision trail, so any mutating route here has to capture the actor itself
  // (CLAUDE.md → Audit logging). Same shape as game-scheduling.js's.
  async function resolveActingUser(req) {
    const userId = req.accountability?.user
    if (!userId) return { name: null, email: null }
    const m = await database('members').where('user', userId).first('first_name', 'last_name', 'email')
    if (!m) return { name: null, email: null }
    const name = [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null
    return { name, email: m.email || null }
  }

  // ── Read-only sync-status gate — wider than superGate ───────────────────────
  // The per-member ClubDesk sync verdict (/clubdesk-sync-status) is status-only
  // (no PII), consumed by the Data Explorer grid, so it opens to the same
  // audience that manages members there: global admins + Vorstand + sport
  // admins. Sensitive PII/mutating ClubDesk routes stay on superGate.
  async function syncStatusGate(req) {
    if (req.accountability?.admin) return true
    const userId = req.accountability?.user
    if (!userId) return false
    const m = await database('members').where('user', userId).first('role')
    if (!m) return false
    const roles = Array.isArray(m.role)
      ? m.role
      : (m.role ? (() => { try { return JSON.parse(m.role) } catch { return [] } })() : [])
    return ['superuser', 'admin', 'vorstand', 'vb_admin', 'bb_admin'].some((r) => roles.includes(r))
  }

  // ── Down ↔ up mutual exclusion (2026-08-04) ─────────────────────────────────
  // down and up are separate columns of the same singleton row, guarded by
  // separate dispatcher crons with separate claim locks — so before this guard
  // NOTHING stopped a superadmin from queueing both in the same minute. They
  // never collided on ClubDesk itself (both scrapes serialise on the shared
  // blocking `.sync.lock`), but two ordering hazards were real:
  //   (a) the up payload — stale-link guard, blank-risk drift, would-duplicate
  //       name match, echo-back — is computed against `clubdesk_export`, i.e.
  //       the LAST COMPLETED sync-down, at the moment /up is called. Queueing
  //       both together builds the push against the pre-down snapshot, so the
  //       refresh the operator just asked for does nothing for it (exactly the
  //       "contact deleted since the last sync-down" abort the up dispatcher
  //       warns about).
  //   (b) the up dispatcher takes `.sync.lock` PER SCRAPE (preview-update,
  //       preview-create, commit-create, commit-update), so a down run can slot
  //       in BETWEEN the dry-run preview and the commit.
  // Hence: whichever direction is queued/running blocks the other, both ways.
  const SYNC_BUSY = ['queued', 'running']
  const isBusy = (state) => SYNC_BUSY.includes(state)

  // ── On-demand ClubDesk MEMBER sync (superadmin "Sync down" button) ──────────
  // POST sets a request flag on the singleton clubdesk_member_sync row; a host
  // dispatcher cron (clubdesk-member-dispatch.sh) claims it, runs clubdesk-sync.sh,
  // and writes back down_state. GET is polled by the button. Sync-up lands later.
  router.get('/clubdesk-member-sync', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const s = await database('clubdesk_member_sync').where('id', 1)
        .first('down_state', 'down_message', 'down_requested_at', 'down_finished_at',
          'down_last_success_at', 'down_phase', 'down_progress', 'down_log',
          'up_state', 'up_phase', 'up_progress', 'up_log')
      return res.json({
        state: s?.down_state || 'idle',
        message: s?.down_message || null,
        requested_at: s?.down_requested_at || null,
        // ⚠ When the last run FINISHED (either outcome) — the poll loop needs it.
        finished_at: s?.down_finished_at || null,
        // ⚠ When a run last SUCCEEDED (migration 336). This is the one a UI may
        // label "last sync": finished_at is stamped on failure too, and showing
        // that as the last sync is how a three-failure outage read as success.
        last_success_at: s?.down_last_success_at || null,
        // ── Live progress (migration 355) ──
        // Written by clubdesk-member-dispatch.sh as the run goes, so the bar can
        // show where the SYNC is instead of where the path is. Until this existed
        // the frontend filled the bar from the step index — a five-minute scrape
        // and a hung login looked identical, which is the complaint that produced
        // the whole feature.
        //
        // ⚠ All three are advisory and may be null: a dispatcher that predates the
        // helper (or could not reach the DB for a progress write) still runs and
        // still reports state correctly. The UI must fall back, never blank out.
        phase: s?.down_phase || null,
        progress: s?.down_progress == null ? null : Number(s.down_progress),
        log: s?.down_log || null,
        // The button greys itself out while a sync-up holds the pipeline (the
        // POST below refuses it anyway — this just makes the block visible).
        up_state: s?.up_state || 'idle',
        // Carried so a step dialog watching the up job can render the same bar
        // without a second poll against a different route.
        up_phase: s?.up_phase || null,
        up_progress: s?.up_progress == null ? null : Number(s.up_progress),
        up_log: s?.up_log || null,
      })
    } catch (err) {
      log.error({ msg: `clubdesk-member-sync status: ${err.message}`, endpoint: 'clubdesk-member-sync', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/clubdesk-member-sync', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const s = await database('clubdesk_member_sync').where('id', 1).first('down_state', 'up_state')
      if (isBusy(s?.down_state)) {
        // ⚠ `code` alongside `state`. The other two lock refusals below carry one
        // and this one did not, so the caller had to INFER the direction from a
        // bare state — and the sync path's toast, unable to name it, showed
        // `API /clubdesk-member-sync: 409` instead (07.09.2026). The state stays
        // for older frontends that read it.
        return res.status(409).json({ error: 'A sync is already in progress', state: s.down_state, code: 'down_in_progress' })
      }
      // A down run between the up's dry-run preview and its commit (hazard (b)
      // above) would refresh clubdesk_export under a push that already passed
      // its preview — refuse until the push settles.
      if (isBusy(s?.up_state)) {
        return res.status(409).json({ error: 'A sync-up is in progress — wait for it to finish', state: s.up_state, code: 'up_in_progress' })
      }
      await database('clubdesk_member_sync').where('id', 1).update({
        down_requested_at: new Date(), down_state: 'queued', down_message: null, down_finished_at: null,
        // ⚠ The progress trio is cleared HERE, not only by the dispatcher's
        // cdp_reset. The dispatchers run on a one-minute cron, so between the
        // click and the claim a queued job rendered the PREVIOUS run's phase, its
        // 100% bar and its whole log — a dialog that opens on "Synced from
        // ClubDesk · 100%" two seconds after you asked for a fresh sync
        // (08.09.2026). cdp_reset stays as the belt-and-braces for a run the
        // dispatcher picks up some other way.
        down_phase: null, down_progress: 0, down_log: null,
      })
      await writeUserLog(database, log, {
        accountability: req.accountability, action: 'update',
        collection: 'clubdesk_member_sync', recordId: 1, data: { kind: 'clubdesk_member_sync_request', direction: 'down' },
      })
      return res.json({ state: 'queued' })
    } catch (err) {
      log.error({ msg: `clubdesk-member-sync trigger: ${err.message}`, endpoint: 'clubdesk-member-sync', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Sync-UP: mute/unmute a member (clubdesk_sync_exclude, migration 190) ────
  // A muted member disappears from both preview lists and is refused by /up —
  // for technical rows (System KSCW) and deliberate never-sync members.
  router.post('/clubdesk-member-sync/mute', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const memberId = Number(req.body?.member_id)
      if (!Number.isInteger(memberId)) return res.status(400).json({ error: 'member_id required' })
      const muted = req.body?.muted !== false // default true
      const n = await database('members').where('id', memberId)
        .update({ clubdesk_sync_exclude: muted })
      if (!n) return res.status(404).json({ error: 'Member not found' })
      await writeUserLog(database, log, {
        accountability: req.accountability, action: 'update',
        collection: 'members', recordId: memberId,
        data: { kind: 'clubdesk_sync_mute', clubdesk_sync_exclude: muted },
      })
      return res.json({ ok: true, member_id: memberId, muted })
    } catch (err) {
      log.error({ msg: `clubdesk mute: ${err.message}`, endpoint: 'clubdesk-member-sync/mute', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  /**
   * The two halves of the push set, as query builders — the ONE definition of
   * "what a sync-up would carry".
   *
   * ⚠ Lifted out of up-preview because a second caller re-derived it and got a
   * different answer. The sync-path runner needs the COUNT (to know whether step
   * 3 has anything to do) and computed it from the /clubdesk-needs-sync
   * worklist instead — where a pushed-awaiting-link member still reads
   * `not_linked`. The path therefore parked on "Sync up" while the modal it
   * opens said "Nothing to push", with no way forward: three members created on
   * 25.08.2026 16:21 held the runner on step 3 while the very step that clears
   * them (the second sync down) sat one place further on, unreachable.
   * Both callers now read the same predicate, so the runner offers step 3 if and
   * only if the modal has rows.
   */
  const pushableUpdates = () => database('members')
    .where('clubdesk_push_pending', true).whereNotNull('clubdesk_id')
    // Muted members (clubdesk_sync_exclude, migration 190 — e.g. the System
    // KSCW technical account) never appear in either preview list.
    .where('clubdesk_sync_exclude', false)
  // ⚠ `clubdesk_pushed_at IS NULL` is not freshness, it is the duplicate guard:
  // a member already pushed as new and not yet linked back must NOT be offered
  // again — see the CREATE-set comment below.
  const pushableCreates = () => database('members')
    .whereNull('clubdesk_id')
    .whereNull('clubdesk_pushed_at')
    .where('clubdesk_sync_exclude', false)

  // ── Sync-UP: preview what would be pushed to ClubDesk ───────────────────────
  // changed  = members edited in wiedisync since the last push AND linked to a
  //            ClubDesk contact (clubdesk_id) → ClubDesk will UPDATE them.
  // unlinked = members with no clubdesk_id (new registrations + divergent-email /
  //            non-member rows) → the superadmin decides per-member whether to
  //            create them (a divergent-email member would otherwise duplicate).
  router.get('/clubdesk-member-sync/up-preview', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      // Short-circuit while a sync-down holds the pipeline. Two reasons to bail
      // BEFORE the queries below rather than after: (1) /up would refuse the
      // push anyway, so a full preview is wasted work the operator can't act
      // on; (2) the down import reloads the snapshot as
      // `BEGIN; TRUNCATE clubdesk_export; \copy …; COMMIT` — every
      // clubdesk_export read below would block on that ACCESS EXCLUSIVE lock
      // until the import commits, hanging the modal on a spinner for the whole
      // run. Reported as a blocked state so the modal says why.
      const busy = await database('clubdesk_member_sync').where('id', 1).first('down_state')
      if (isBusy(busy?.down_state)) {
        return res.json({ changed: [], unlinked: [], blocked_by_down: busy.down_state })
      }
      const changedRows = await pushableUpdates()
        .select('id', 'first_name', 'last_name', 'email', 'clubdesk_id', 'clubdesk_push_changes')
        .orderBy('last_name')
      // Stale-link flag (2026-07-08): a changed member whose clubdesk_id has no
      // clubdesk_export row anymore (contact deleted CD-side) will be SKIPPED by
      // /up's stale-link guard — surface that here so the modal can show why and
      // offer mute instead of silently re-listing the member forever.
      const changedCdids = [...new Set(changedRows.map((m) => String(m.clubdesk_id).trim()).filter(Boolean))]
      const liveCdids = new Set()
      if (changedCdids.length) {
        const rows = await database('clubdesk_export')
          .whereRaw('BTRIM(clubdesk_id) = ANY(?)', [changedCdids])
          .distinct(database.raw('BTRIM(clubdesk_id) AS cdid'))
        for (const r of rows) liveCdids.add(r.cdid)
      }
      const changed = changedRows.map((m) => {
        let changes = []
        try { changes = Array.isArray(m.clubdesk_push_changes) ? m.clubdesk_push_changes : (m.clubdesk_push_changes ? JSON.parse(m.clubdesk_push_changes) : []) } catch { changes = [] }
        return { id: m.id, first_name: m.first_name, last_name: m.last_name, email: m.email, clubdesk_id: m.clubdesk_id, changes, stale: !liveCdids.has(String(m.clubdesk_id).trim()) }
      })
      // Exclude members already pushed as "new" but not yet linked back: the
      // up-dispatcher stamps clubdesk_pushed_at on every pushed row, so an unlinked
      // (clubdesk_id IS NULL) member with a clubdesk_pushed_at is "pushed, awaiting
      // link" — offering it again would DUPLICATE the contact in ClubDesk. It
      // reappears here only once a write-back sets its clubdesk_id (TODO: scrape the
      // new ClubDesk [Id] back — see clubdesk-member-up-dispatch.sh).
      const unlinkedRows = await pushableCreates()
        .select('id', 'first_name', 'last_name', 'email', 'beitragskategorie',
          'scorer_vb', 'referee_vb', 'otr1_bb', 'otr2_bb', 'otn1_bb', 'otn2_bb', 'referee_bb',
          // `birthdate` gates the youth surcharge (isU16Plus). Without it the
          // preview reported the un-surcharged amount for every youth-category
          // member while the commit path — which selects PUSH_FIELDS — pushed
          // the surcharged one, so the superadmin approved a number the push
          // did not send.
          'birthdate',
          // Per-member fee overrides (migration 299), same reason: preview the
          // amount that will actually be created in ClubDesk.
          ...FEE_OVERRIDE_FIELDS)
        .orderBy('last_name')
      // Flag unlinked members who ALREADY exist in ClubDesk under a divergent
      // email (exact first+last name match) so the modal can warn before a CREATE
      // push duplicates the contact in the legal register (2026-07-05 audit #11).
      // Name-only is a heuristic — the superadmin still decides per-member — but
      // the server no longer stays silent about a likely duplicate.
      const cdKey = (f, l) => `${(f || '').trim().toLowerCase()} ${(l || '').trim().toLowerCase()}`.trim()
      const wantNames = [...new Set(unlinkedRows.map((m) => cdKey(m.first_name, m.last_name)).filter(Boolean))]
      const cdNames = new Set()
      if (wantNames.length) {
        const rows = await database('clubdesk_export')
          .whereRaw("LOWER(BTRIM(vorname)) || ' ' || LOWER(BTRIM(nachname)) = ANY(?)", [wantNames])
          .distinct(database.raw("LOWER(BTRIM(vorname)) || ' ' || LOWER(BTRIM(nachname)) AS nm"))
        for (const r of rows) cdNames.add(r.nm)
      }
      // Guest CREATE contacts preview the reduced Mitgliederbeitrag too — same
      // roster-based resolution as the commit path so the number the superadmin
      // approves is exactly what gets pushed.
      const unlinkedGuests = await guestMemberIdSet(database, unlinkedRows.map((m) => m.id), getCurrentSeason())
      const unlinked = unlinkedRows.map((m) => {
        const e = (m.email || '').toLowerCase()
        const likelyNonMember = e.includes('@kscw.clubdesk.com') || e.startsWith('system@') || e.endsWith('@kscw.ch')
        return {
          id: m.id, first_name: m.first_name, last_name: m.last_name, email: m.email,
          likely_non_member: likelyNonMember,
          // A ClubDesk contact with this exact name already exists (divergent
          // email) → pushing CREATE would duplicate it. Warn in the modal.
          would_duplicate: cdNames.has(cdKey(m.first_name, m.last_name)),
          // What the CREATE push will send as Beitragskategorie (post-mapping),
          // Offiziellen Lizenz and Mitgliederbeitrag — shown in the modal so
          // the superadmin sees them before approving.
          beitragskategorie: mapKategorie(m.beitragskategorie) || null,
          offiziellen_lizenz: deriveOffiziellenLizenz(m) || null,
          mitgliederbeitrag: deriveMitgliederbeitrag(m.beitragskategorie, m, { isGuest: unlinkedGuests.has(Number(m.id)) }) || null,
        }
      })
      return res.json({ changed, unlinked })
    } catch (err) {
      log.error({ msg: `up-preview: ${err.message}`, endpoint: 'clubdesk-member-sync/up-preview', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Sync-UP: commit — stash the approved CSV + member ids, enqueue the push ──
  // The host up-dispatcher reads up_csv, runs the import scraper (commit), clears
  // clubdesk_push_pending for up_member_ids, and writes up_result.
  router.post('/clubdesk-member-sync/up', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const ids = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(Number).filter((n) => Number.isInteger(n)) : []
      if (!ids.length) return res.status(400).json({ error: 'member_ids required' })
      const s = await database('clubdesk_member_sync').where('id', 1).first('up_state', 'down_state')
      if (isBusy(s?.up_state)) {
        return res.status(409).json({ error: 'A sync-up is already in progress', state: s.up_state })
      }
      // Everything below (stale-link guard, blank-risk drift, would-duplicate
      // match, echo-back) reads clubdesk_export — the LAST COMPLETED sync-down.
      // Pushing against a snapshot a running down-sync is about to replace is
      // hazard (a) above: the payload is frozen here, so the refresh cannot help
      // it. Refuse and let the operator re-open the modal once the down settles.
      if (isBusy(s?.down_state)) {
        return res.status(409).json({ error: 'A sync-down is in progress — wait for it to finish, then review the push again', state: s.down_state, code: 'down_in_progress' })
      }
      const fetched = await database('members').whereIn('id', ids)
        .select([...PUSH_FIELDS, 'clubdesk_push_pending', 'clubdesk_pushed_at', 'clubdesk_sync_exclude'])
      // Server-side eligibility re-check — mirrors up-preview: an UPDATE push needs
      // a linked contact with pending changes; a CREATE push must be neither linked
      // nor already pushed (a pushed-awaiting-link member would DUPLICATE the
      // contact in ClubDesk). Muted members (clubdesk_sync_exclude) are refused
      // outright. The preview enforced this only client-side, but /up callers can
      // act on stale state (per-registration zone, second admin), so refuse
      // ineligible ids here.
      const members = fetched.filter((m) =>
        !m.clubdesk_sync_exclude &&
        ((m.clubdesk_push_pending && m.clubdesk_id) || (!m.clubdesk_id && !m.clubdesk_pushed_at)))
      if (!members.length) {
        return res.status(409).json({ error: 'No eligible members — already in ClubDesk or awaiting link-back', code: 'not_eligible' })
      }
      // Split into the two push sets: linked members get a contact-fields-only
      // UPDATE row; unlinked members get a CREATE row that additionally carries
      // Beitragskategorie + Eintritt + Gruppen (see CD_PUSH_CREATE_HEADERS for
      // why the sets must never share a CSV).
      const updates0 = members.filter((m) => m.clubdesk_id)
      const creates0 = members.filter((m) => !m.clubdesk_id)
      // Duplicate-CREATE guard. up-preview flags `would_duplicate` (a ClubDesk
      // contact already exists under this exact first+last name, divergent email)
      // so the modal can warn — but nothing re-checked it here, so an approved
      // CREATE could still duplicate the contact in the legal register (the
      // 2026-07-05 audit #11 gap: the flag was computed, surfaced, then ignored
      // on commit). Re-run the SAME name match server-side and skip collisions —
      // the operator relinks the member to the existing contact instead. Mirrors
      // the stale-link / blank-risk guards: refuse rather than write a dup.
      let wouldDuplicateSkipped = []
      let creates = creates0
      if (creates0.length) {
        const cdKey = (f, l) => `${(f || '').trim().toLowerCase()} ${(l || '').trim().toLowerCase()}`.trim()
        const wantNames = [...new Set(creates0.map((m) => cdKey(m.first_name, m.last_name)).filter(Boolean))]
        if (wantNames.length) {
          const rows = await database('clubdesk_export')
            .whereRaw("LOWER(BTRIM(vorname)) || ' ' || LOWER(BTRIM(nachname)) = ANY(?)", [wantNames])
            .distinct(database.raw("LOWER(BTRIM(vorname)) || ' ' || LOWER(BTRIM(nachname)) AS nm"))
          const cdNames = new Set(rows.map((r) => r.nm))
          wouldDuplicateSkipped = creates0.filter((m) => cdNames.has(cdKey(m.first_name, m.last_name))).map((m) => m.id)
          if (wouldDuplicateSkipped.length) {
            const skip = new Set(wouldDuplicateSkipped)
            creates = creates0.filter((m) => !skip.has(m.id))
          }
        }
      }
      // Blank-risk guard (2026-07-05 audit #5). An UPDATE row carries the FULL
      // contact scope, so a linked member whose wiedisync side is EMPTY where
      // ClubDesk still holds a value would blank the authoritative register on
      // import. /clubdesk-drift/flag already refuses these, but the member-facing
      // POST /clubdesk-update sets clubdesk_push_pending with no such check, so a
      // profile edit that clears a field can reach here. Re-run the SAME drift
      // computation over the UPDATE set and drop blank-risk members — they
      // self-heal after a "Sync down" fills the empty field.
      let blankRiskSkipped = []
      let updates = updates0
      if (updates0.length) {
        const drift = await computeClubdeskDrift(updates0.map((m) => m.id))
        const riskyIds = new Set(drift.filter((d) => d.blank_risk.length).map((d) => d.member_id))
        if (riskyIds.size) {
          blankRiskSkipped = updates0.filter((m) => riskyIds.has(m.id)).map((m) => m.id)
          updates = updates0.filter((m) => !riskyIds.has(m.id))
        }
      }
      // Stale-link guard + echo-back — both need the member's clubdesk_export
      // row, so they share one query. MUST run before pushMembers is fixed:
      // a skipped member must not land in up_member_ids (the dispatcher clears
      // clubdesk_push_pending for every id in there after a commit).
      //
      // Stale-link guard (2026-07-08, spike-proven): UPDATE rows are [Id]-keyed,
      // and an [Id] that no longer exists in ClubDesk (contact deleted CD-side —
      // the Grie Chaisena case) makes the import wizard hard-abort the ENTIRE
      // upload: the dialog closes silently, no summary, NOTHING of the batch is
      // written. One stale link would brick the whole push, so skip those
      // members here and report them; the operator mutes (clubdesk_sync_exclude)
      // or relinks. clubdesk_export mirrors "Alle Kontakte" (every contact incl.
      // exited), so a missing row genuinely means the contact is gone — the only
      // false positive is a hand-typed clubdesk_id newer than the last sync-down,
      // which self-heals after the next "Sync down".
      //
      // Echo-back: an UPDATE row whose wiedisync value is empty gets ClubDesk's
      // own current value so the import can never blank the register. Covers
      // iban + anrede + nationalitaet + ahv_nummer + federation_of_origin — the
      // fields wiedisync does not exclusively own. Member-set values pass
      // unchanged. The drift blank-risk guard deliberately skips these five —
      // this makes them structurally safe instead of dropping the member from
      // the push.
      // (Spike 2026-07-08 additionally proved ClubDesk IGNORES empty cells on
      // import — the echo + blank-risk guards stay as defense-in-depth on the
      // legal register; one probe on one field type is no licence to relax.)
      let staleLinkSkipped = []
      if (updates.length) {
        // .trim() to match the BTRIM'd export side + the trimmed lookups below —
        // an untrimmed param here turns a hand-linked padded clubdesk_id into a
        // permanent false "stale link" skip (review finding 2026-07-08).
        const cdids = updates.map((m) => String(m.clubdesk_id).trim()).filter(Boolean)
        const echoRows = cdids.length ? await database.raw(`
          SELECT DISTINCT ON (BTRIM(clubdesk_id)) BTRIM(clubdesk_id) AS cdid,
                 iban, anrede, nationalitaet, ahv_nummer, federation_of_origin,
                 trainer_lizenz, telefon_privat, adresse, plz, ort,
                 beitragskategorie, eintritt, mitgliederbeitrag, lizenznummer, lizenzart,
                 status, austritt, offiziellen_lizenz
          FROM clubdesk_export WHERE BTRIM(clubdesk_id) = ANY(?) ORDER BY BTRIM(clubdesk_id), row_id
        `, [cdids]) : { rows: [] }
        const cdEcho = new Map(echoRows.rows.map((r) => [r.cdid, r]))
        staleLinkSkipped = updates.filter((m) => !cdEcho.has(String(m.clubdesk_id).trim())).map((m) => m.id)
        if (staleLinkSkipped.length) updates = updates.filter((m) => cdEcho.has(String(m.clubdesk_id).trim()))
        for (const m of updates) {
          const cd = cdEcho.get(String(m.clubdesk_id).trim()) || {}
          if (!String(m.iban || '').trim()) m.iban = String(cd.iban || '').trim()
          if (!String(m.anrede || '').trim()) m.anrede = String(cd.anrede || '').trim()
          if (!String(m.nationalitaet || '').trim()) m.nationalitaet = String(cd.nationalitaet || '').trim()
          if (!String(m.ahv_nummer || '').trim()) m.ahv_nummer = String(cd.ahv_nummer || '').trim()
          // ⚠⚠ Address + phone joined the echo on 2026-08-30, which is what takes
          // them OUT of blank_risk (see computeClubdeskDrift). They were in the
          // push scope from day one and never echoed, so an empty wiedisync cell
          // made the member blank-risky — dropped from EVERY push, with no way
          // back: a sync-down cannot heal a member it skips for being
          // push-pending, and since migration 321 it would only PROPOSE the fill
          // anyway. Echoing ClubDesk's own value makes the cell a provable
          // no-op, exactly as it has always done for IBAN and Anrede.
          if (!String(m.adresse || '').trim()) m.adresse = String(cd.adresse || '').trim()
          if (!String(m.plz || '').trim()) m.plz = String(cd.plz || '').trim()
          if (!String(m.ort || '').trim()) m.ort = String(cd.ort || '').trim()
          // ⚠ Phone echoes ONE HOP (like Federation of Origin), not back onto
          // m.phone: buildPushCsv runs m.phone through normalizePhone as an
          // outgoing repair, and canonicalising a number we are only handing
          // back would REWRITE a register cell wiedisync has no opinion about.
          // The mirror is sent verbatim. `Telefon Privat` is the only phone
          // column an UPDATE row writes — echoing Mobil here would MOVE the
          // number between columns, which is a mutation, not an echo.
          if (!String(m.phone || '').trim()) m.phone_cd = String(cd.telefon_privat || '').trim()
          // Federation of Origin echoes into a SEPARATE field, not back onto
          // federation_of_origin itself: that column holds an ISO code (CHECK
          // constraint, migration 223) while ClubDesk's cell is a German picklist
          // string — assigning it here would fail federationCell's code lookup and
          // emit an empty cell, i.e. exactly the blanking this guard prevents.
          // buildPushCsv falls back to this raw value when the member has no answer.
          if (!String(m.federation_of_origin || '').trim()) m.federation_of_origin_cd = String(cd.federation_of_origin || '').trim()
          // Trainer Lizenz — one-hop echo for the same reason as the line above:
          // members.trainer_licences holds CODES under a CHECK constraint while
          // ClubDesk's cell holds the human wording, so assigning it back here
          // would both fail the constraint and emit the blank it guards against.
          if (!String(m.trainer_licences || '').trim()) m.trainer_licences_cd = String(cd.trainer_lizenz || '').trim()
          // Fill-only billing mirrors (2026-07-27, see CD_PUSH_HEADERS): stashed
          // UNCONDITIONALLY, because here the precedence is reversed — ClubDesk's
          // own value always wins in buildPushCsv, and wiedisync's derivation is
          // only the fallback for a register cell that is empty. Eintritt is
          // ClubDesk's export string (dd.mm.yyyy) and Mitgliederbeitrag can hold
          // a manual per-person override — both travel verbatim.
          m.beitragskategorie_cd = String(cd.beitragskategorie || '').trim()
          m.eintritt_cd = String(cd.eintritt || '').trim()
          m.mitgliederbeitrag_cd = String(cd.mitgliederbeitrag || '').trim()
          m.lizenznummer_cd = String(cd.lizenznummer || '').trim()
          m.lizenzart_cd = String(cd.lizenzart || '').trim()
          // The register triple's echo (migration 302). Stashed for EVERY update
          // member, not just the ones whose push names them: registerCell falls
          // back to these whenever the member did not deliberately change the
          // field, which is what keeps an unrelated push from rewriting Status.
          m.register_status_cd = String(cd.status || '').trim()
          m.austritt_cd = String(cd.austritt || '').trim()
          // Offiziellen Lizenz (2026-08-14). Same unconditional stash as the
          // billing mirrors above and for the same reason — this cell is
          // fill-only, so ClubDesk's own value is the FIRST choice, not a
          // fallback. An unstashed mirror here would silently promote the
          // column to "wiedisync always wins".
          m.offiziellen_lizenz_cd = String(cd.offiziellen_lizenz || '').trim()
        }
      }
      const pushMembers = [...updates, ...creates]
      if (!pushMembers.length) {
        const staleOnly = staleLinkSkipped.length && !blankRiskSkipped.length && !wouldDuplicateSkipped.length
        const dupOnly = wouldDuplicateSkipped.length && !blankRiskSkipped.length && !staleLinkSkipped.length
        return res.status(409).json({
          error: dupOnly
            ? 'Every eligible member already exists in ClubDesk under this name (divergent email) — relink them to the existing contact instead of creating a duplicate'
            : staleOnly
              ? 'Every eligible member has a stale ClubDesk link (contact no longer exists in ClubDesk) — mute or relink them'
              // ⚠ NOT "run Sync down first". Since migration 321 a sync-down
              // only PROPOSES the fill, and it skips clubdesk_push_pending
              // members outright — so for the members who see this, the old
              // advice was unreachable twice over. Name the thing that actually
              // clears it.
              : 'Every eligible member would blank ClubDesk data (empty fields ClubDesk still owns) — fill those fields in wiedisync, or accept the pending fill proposals; a sync-down cannot do it for a member already flagged for a push',
          code: dupOnly ? 'would_duplicate' : staleOnly ? 'stale_link' : 'blank_risk',
          skipped_blank_risk: blankRiskSkipped, skipped_stale_link: staleLinkSkipped,
          skipped_would_duplicate: wouldDuplicateSkipped,
        })
      }
      // Eintritt = the registration SUBMISSION date — user rule 2026-07-06:
      // "the date the registration is sent" (approved_at was dropped; it is
      // also not stamped on every approval path). Gruppen = deriveGruppen(reg)
      // from the same registration (team +
      // funktion). Registration → member resolution uses the same email +
      // symmetric first-name-prefix rule as cdStatusForRegistration, so a child
      // on the parent's shared address never inherits the parent's date or
      // teams. No match (legacy/manual member) → empty cells; a new contact has
      // Guest resolution for the WHOLE push (both sets): every row carries a Gast
      // cell now (CD_PUSH_CONTACT_HEADERS), and the CREATE rows additionally bill
      // the reduced Mitgliederbeitrag off the same flag. One query over
      // pushMembers rather than one per set, so an update row and a create row
      // can never be resolved against different definitions.
      const guestIds = await guestMemberIdSet(database, pushMembers.map((m) => m.id), getCurrentSeason())
      for (const m of pushMembers) m.is_guest = guestIds.has(Number(m.id))
      // no ClubDesk Eintritt/Gruppen to blank, so empty is safe there.
      // Since 2026-07-27 the UPDATE rows carry a fill-only Eintritt cell too
      // (see CD_PUSH_HEADERS), so the registration lookup runs over the WHOLE
      // push, not just the creates — same approved-only filter, same email +
      // first-name matching, and the create path resolves exactly what it
      // always did. An update member's m.eintritt only ever reaches the CSV
      // when ClubDesk's own Eintritt is empty (the eintritt_cd echo wins), so a
      // contact created ClubDesk-side and linked afterwards finally gets its
      // entry date without a register-set one ever being touched.
      if (pushMembers.length) {
        const emails = [...new Set(pushMembers.map((m) => String(m.email || '').toLowerCase().trim()).filter(Boolean))]
        const regs = emails.length
          ? await database('registrations').where('status', 'approved')
            .whereRaw('LOWER(BTRIM(email)) = ANY(?)', [emails])
            .select('email', 'vorname', 'submitted_at', 'membership_type', 'team', 'rolle', 'sektion_choice', 'lizenz')
          : []
        for (const m of pushMembers) {
          const em = String(m.email || '').toLowerCase().trim()
          const reg = regs
            .filter((r) => String(r.email || '').toLowerCase().trim() === em && firstNamesMatchCd(r.vorname, m.first_name))
            .sort((a, b) => new Date(a.submitted_at || 0) - new Date(b.submitted_at || 0))[0]
          // ⚠ NOT `m.eintritt` — that is the real column now (migration 302),
          // selected by PUSH_FIELDS. Overwriting it here would push the
          // registration date over an entry date an admin had corrected.
          m.eintritt_registration = reg ? reg.submitted_at : null
          // The remaining create-set extras (Gruppen/Status/Sektion)
          // stay off UPDATE rows — ClubDesk-authoritative there, no fill.
          if (m.clubdesk_id) continue
          m.gruppen = deriveGruppen(reg)
          m.cd_status = deriveStatus(reg, m)
          m.cd_sektion = deriveSektion(reg)
          // m.is_guest is already set for every push member above — the CREATE
          // path only consumes it (Mitgliederbeitrag + the Gast cell).
        }
      }
      // ONE lookup for the whole push: the Federation of Origin cell needs the
      // code → ClubDesk-German map (see loadCountryPushNames). Threaded into
      // both CSVs rather than queried per row.
      const countryNames = await loadCountryPushNames(database)
      await database('clubdesk_member_sync').where('id', 1).update({
        up_requested_at: new Date(), up_state: 'queued', up_message: null, up_finished_at: null,
        // ⚠ The progress trio is cleared HERE, not only by the dispatcher's
        // cdp_reset. The dispatchers run on a one-minute cron, so between the
        // click and the claim a queued job rendered the PREVIOUS run's phase, its
        // 100% bar and its whole log — a dialog that opens on "Synced from
        // ClubDesk · 100%" two seconds after you asked for a fresh sync
        // (08.09.2026). cdp_reset stays as the belt-and-braces for a run the
        // dispatcher picks up some other way.
        up_phase: null, up_progress: 0, up_log: null,
        up_csv: updates.length ? buildPushCsv(updates, { countryNames }) : null,
        up_csv_create: creates.length ? buildPushCsv(creates, { create: true, countryNames }) : null,
        up_member_ids: JSON.stringify(pushMembers.map((m) => m.id)),
        up_member_ids_create: JSON.stringify(creates.map((m) => m.id)),
        up_result: null,
      })
      await writeUserLog(database, log, {
        accountability: req.accountability, action: 'update',
        collection: 'clubdesk_member_sync', recordId: 1,
        data: { kind: 'clubdesk_member_sync_request', direction: 'up', member_count: pushMembers.length, create_count: creates.length, skipped_blank_risk: blankRiskSkipped.length, skipped_stale_link: staleLinkSkipped.length, skipped_would_duplicate: wouldDuplicateSkipped.length },
      })
      return res.json({ state: 'queued', count: pushMembers.length, skipped_blank_risk: blankRiskSkipped, skipped_stale_link: staleLinkSkipped, skipped_would_duplicate: wouldDuplicateSkipped })
    } catch (err) {
      log.error({ msg: `up-commit: ${err.message}`, endpoint: 'clubdesk-member-sync/up', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  router.get('/clubdesk-member-sync/up-status', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const s = await database('clubdesk_member_sync').where('id', 1)
        .first('up_state', 'up_message', 'up_requested_at', 'up_finished_at', 'up_result',
          'up_phase', 'up_progress', 'up_log')
      let result = null
      try { result = s?.up_result ? (typeof s.up_result === 'object' ? s.up_result : JSON.parse(s.up_result)) : null } catch { result = null }
      return res.json({
        state: s?.up_state || 'idle',
        message: s?.up_message || null,
        requested_at: s?.up_requested_at || null,
        finished_at: s?.up_finished_at || null,
        result,
        // Live progress (migration 355) — advisory, may be null. See the note on
        // the sync-down status route.
        phase: s?.up_phase || null,
        progress: s?.up_progress == null ? null : Number(s.up_progress),
        log: s?.up_log || null,
      })
    } catch (err) {
      log.error({ msg: `up-status: ${err.message}`, endpoint: 'clubdesk-member-sync/up-status', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Name-only ClubDesk matches (Data Health manual-link check) ──────────────
  // Members whose first+last name matches a ClubDesk contact but whose email AND
  // licence both DIVERGE — so the automatic linker (licence / email+name) can't
  // safely link them. Surfaced in Data Health for a human to confirm: link sets
  // clubdesk_id and stores the ClubDesk email as a secondary (vm_email). If the
  // matched ClubDesk contact is already linked to a DIFFERENT member, it's a
  // likely duplicate-member case (needs a merge, not a link) — flagged, not
  // offered as a one-click link. clubdesk_export is a staging table not exposed
  // via the items API, so this join lives server-side. Superadmin only.
  router.get('/clubdesk-name-matches', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const rows = await database
        .select(
          'm.id as member_id', 'm.first_name', 'm.last_name', 'm.email as member_email',
          'cd.clubdesk_id', 'cd.email as cd_email', 'cd.email_alternativ as cd_email_alt',
          'cd.lizenznummer as cd_lic', 'linked.id as linked_member_id',
          'linked.first_name as linked_first', 'linked.last_name as linked_last',
        )
        .from('members as m')
        .join('clubdesk_export as cd', function () {
          this.on(database.raw('LOWER(BTRIM(cd.vorname)) = LOWER(BTRIM(m.first_name))'))
            .andOn(database.raw('LOWER(BTRIM(cd.nachname)) = LOWER(BTRIM(m.last_name))'))
            .andOn(database.raw("NULLIF(BTRIM(cd.clubdesk_id), '') IS NOT NULL"))
        })
        .leftJoin('members as linked', database.raw('linked.clubdesk_id = BTRIM(cd.clubdesk_id)'))
        .whereNull('m.clubdesk_id')
        .andWhereRaw("LOWER(BTRIM(m.email)) NOT IN (LOWER(BTRIM(cd.email)), LOWER(BTRIM(COALESCE(cd.email_alternativ,''))))")
        .andWhereRaw("(NULLIF(BTRIM(m.license_nr),'') IS NULL OR LOWER(BTRIM(m.license_nr)) <> LOWER(BTRIM(COALESCE(cd.lizenznummer,''))))")
        .orderBy(['m.last_name', 'm.first_name'])
      const candidates = rows.map((r) => ({
        member_id: r.member_id,
        member_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        member_email: r.member_email,
        clubdesk_id: String(r.clubdesk_id).trim(),
        clubdesk_email: r.cd_email || r.cd_email_alt || null,
        clubdesk_licence: r.cd_lic || null,
        // When set, the ClubDesk contact is already linked to another member →
        // duplicate, needs a merge (no one-click link).
        duplicate_of: r.linked_member_id
          ? { id: r.linked_member_id, name: `${r.linked_first || ''} ${r.linked_last || ''}`.trim() }
          : null,
      }))
      return res.json({ candidates })
    } catch (err) {
      log.error({ msg: `clubdesk-name-matches: ${err.message}`, endpoint: 'clubdesk-name-matches', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // Confirm a name-only match: set the member's clubdesk_id and keep the ClubDesk
  // email as a secondary (vm_email, fill-only). Refuses if the ClubDesk contact is
  // already linked to another member (that's a merge, handled elsewhere).
  router.post('/clubdesk-link', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const memberId = Number(req.body?.member_id)
      const clubdeskId = String(req.body?.clubdesk_id || '').trim()
      if (!Number.isInteger(memberId) || !clubdeskId) {
        return res.status(400).json({ error: 'member_id and clubdesk_id required' })
      }
      const member = await database('members').where('id', memberId).first('id', 'clubdesk_id', 'vm_email', 'email')
      if (!member) return res.status(404).json({ error: 'Member not found' })
      if (member.clubdesk_id) return res.status(409).json({ error: 'Member already linked' })
      const taken = await database('members').where('clubdesk_id', clubdeskId).whereNot('id', memberId).first('id')
      if (taken) return res.status(409).json({ error: 'ClubDesk contact already linked to another member', code: 'duplicate' })
      const cd = await database('clubdesk_export').whereRaw('BTRIM(clubdesk_id) = ?', [clubdeskId])
        .first('email', 'email_alternativ')
      const cdEmail = (cd?.email || cd?.email_alternativ || '').trim() || null
      const patch = { clubdesk_id: clubdeskId }
      // Keep the ClubDesk email as secondary unless the member already has a
      // distinct one. Never overwrite their primary.
      if (cdEmail && (!member.vm_email || member.vm_email.toLowerCase() === (member.email || '').toLowerCase())) {
        patch.vm_email = cdEmail
      }
      await database('members').where('id', memberId).update(patch)
      await writeUserLog(database, log, {
        accountability: req.accountability, action: 'update',
        collection: 'members', recordId: memberId,
        data: { kind: 'clubdesk_link', clubdesk_id: clubdeskId, vm_email: patch.vm_email || null },
      })
      return res.json({ success: true, member_id: memberId, clubdesk_id: clubdeskId, vm_email: patch.vm_email || null })
    } catch (err) {
      log.error({ msg: `clubdesk-link: ${err.message}`, endpoint: 'clubdesk-link', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Per-registration ClubDesk status (Anmeldungen "ClubDesk sync" zone) ─────
  // Resolves an approved registration to its member row (same email +
  // symmetric first-name-prefix rule as createMemberFromRegistration in
  // kscw-hooks) and reports where that person stands relative to ClubDesk:
  //   linked          — member.clubdesk_id set → contact exists in ClubDesk
  //   match_unlinked  — a clubdesk_export contact matches by email or exact name
  //                     but the member isn't linked yet (offer /clubdesk-link);
  //                     `duplicate_of` is set when that contact is already linked
  //                     to a DIFFERENT member (needs a merge, no one-click action)
  //   pushed_pending  — pushed to ClubDesk (clubdesk_pushed_at) awaiting link-back
  //   not_in_clubdesk — nowhere to be found → offer the single-member sync-up push
  //   no_member       — no member row yet (not approved, or the approval hook failed)
  // clubdesk_export is the last sync-down snapshot, so "in ClubDesk" is as of the
  // last sync down. Read-only. Superadmin only (same gate as the sync surface).
  function firstNamesMatchCd(a, b) {
    const x = String(a || '').toLowerCase().trim()
    const y = String(b || '').toLowerCase().trim()
    if (!x || !y) return true
    return x === y || x.startsWith(y) || y.startsWith(x)
  }

  async function cdStatusForRegistration(reg) {
      if (!reg || !reg.email) return { status: 'no_member' }

      const email = reg.email.toLowerCase().trim()
      const MEMBER_COLS = ['id', 'uuid', 'first_name', 'last_name', 'clubdesk_id', 'clubdesk_pushed_at']
      // ID-FIRST (user rule 2026-07-08: "lookup should be by ID"). The approval
      // hook stamps registrations.member (migration 194 backfilled legacy rows),
      // so the FK is the authoritative link — the heuristics below only cover
      // unstamped legacy rows the backfill couldn't uniquely resolve.
      let member = null
      if (reg.member) {
        member = await database('members').where('id', reg.member).first(...MEMBER_COLS) || null
      }
      if (!member) {
        const emailRows = await database('members').whereRaw('LOWER(email) = ?', [email])
          .select(...MEMBER_COLS)
        member = emailRows.find((r) => firstNamesMatchCd(r.first_name, reg.vorname)) || null
      }
      if (!member) {
        // Divergent-email fallback (2026-07-08, Neo Paladino case): a child often
        // registers under a PARENT's email while the member row (materialized
        // from ClubDesk, or later edited) carries the person's own address — the
        // email-only lookup then shows a false "no member record" for someone who
        // exists and is even linked. Fall back to exact last-name equality + the
        // symmetric first-name-prefix rule, and accept ONLY a unique candidate
        // (ambiguity keeps no_member — this result also feeds the one-click link
        // zone, so we never guess between two same-named people).
        const nachname = String(reg.nachname || '').toLowerCase().trim()
        if (nachname) {
          const nameRows = await database('members')
            .whereRaw('LOWER(BTRIM(last_name)) = ?', [nachname])
            .select(...MEMBER_COLS)
          const hits = nameRows.filter((r) => firstNamesMatchCd(r.first_name, reg.vorname))
          if (hits.length === 1) member = hits[0]
        }
      }
      if (!member) return { status: 'no_member' }

      const base = { member_id: member.id }
      if (member.clubdesk_id) {
        return { ...base, status: 'linked', clubdesk_id: member.clubdesk_id }
      }

      // Unlinked → AUTHORITATIVE KEY FIRST (2026-07-08, "lookup should be by
      // ID"): the contact may already carry this member's Wiedisync ID (pushed
      // on every create + update; the down-sync linker reads it back). A
      // snapshot row holding it IS this member's contact — no name/email
      // guessing, no ambiguity. Pre-184 stamps carried the numeric members.id,
      // so accept both formats (same rule as the down-sync linker).
      const widKeys = [
        member.uuid ? String(member.uuid).toLowerCase().trim() : null,
        String(member.id),
      ].filter(Boolean)
      const widRow = await database('clubdesk_export')
        .whereRaw('LOWER(BTRIM(wiedisync_id)) = ANY(?)', [widKeys])
        .whereRaw("NULLIF(BTRIM(clubdesk_id), '') IS NOT NULL")
        .orderBy('row_id')
        .first('clubdesk_id', 'vorname', 'nachname', 'email', 'email_alternativ')
      if (widRow) {
        const widCdid = String(widRow.clubdesk_id).trim()
        const widLinked = await database('members').where('clubdesk_id', widCdid)
          .first('id', 'first_name', 'last_name')
        return {
          ...base,
          status: 'match_unlinked',
          clubdesk_id: widCdid,
          clubdesk_name: `${(widRow.vorname || '').trim()} ${(widRow.nachname || '').trim()}`.trim() || null,
          clubdesk_email: widRow.email || widRow.email_alternativ || null,
          ambiguous: false,
          matched_by: 'wiedisync_id',
          duplicate_of: widLinked && widLinked.id !== member.id
            ? { id: widLinked.id, name: `${widLinked.first_name || ''} ${widLinked.last_name || ''}`.trim() }
            : null,
        }
      }

      // Heuristic candidates (legacy contacts without a Wiedisync ID). Candidates
      // come from an email or exact-name SQL match, but an email hit only COUNTS when
      // the contact's name also matches the member — same family-shared-email rule
      // as createMemberFromRegistration and the sync-down auto-linker: a child
      // registering with the parent's address must never be offered a one-click
      // link to the parent's contact. clubdesk_export holds one row per contact
      // PER GROUP, so dedupe by clubdesk_id; email+name beats name-only; two
      // DIFFERENT contacts at the same precedence → ambiguous, no one-click link.
      // Checked BEFORE pushed_pending so a contact that appeared via sync-down
      // without linking offers the link action instead of waiting forever.
      const lastNamesEqual = (a, b) => {
        const x = String(a || '').toLowerCase().trim()
        const y = String(b || '').toLowerCase().trim()
        return !!x && !!y && x === y
      }
      const cdRows = await database('clubdesk_export as cd')
        .whereRaw("NULLIF(BTRIM(cd.clubdesk_id), '') IS NOT NULL")
        .andWhere(function () {
          this.whereRaw('LOWER(BTRIM(cd.email)) = ?', [email])
            .orWhereRaw("LOWER(BTRIM(COALESCE(cd.email_alternativ, ''))) = ?", [email])
            .orWhere(function () {
              this.whereRaw('LOWER(BTRIM(cd.vorname)) = LOWER(BTRIM(?))', [member.first_name || ''])
                .andWhereRaw('LOWER(BTRIM(cd.nachname)) = LOWER(BTRIM(?))', [member.last_name || ''])
            })
        })
        .select('cd.clubdesk_id', 'cd.vorname', 'cd.nachname', 'cd.email', 'cd.email_alternativ')
      const seen = new Set()
      const candidates = []
      for (const r of cdRows) {
        const cdid = String(r.clubdesk_id).trim()
        if (seen.has(cdid)) continue
        const nameHit = lastNamesEqual(r.nachname, member.last_name)
          && firstNamesMatchCd(r.vorname, member.first_name)
        if (!nameHit) continue // email-only hit = different person on a shared address
        seen.add(cdid)
        const emailHit = [r.email, r.email_alternativ]
          .some((e) => String(e || '').toLowerCase().trim() === email)
        candidates.push({ cdid, emailHit, vorname: r.vorname, nachname: r.nachname, email: r.email || r.email_alternativ || null })
      }
      candidates.sort((a, b) => Number(b.emailHit) - Number(a.emailHit))
      const cd = candidates[0] || null
      const ambiguous = candidates.length > 1 && candidates[1].emailHit === candidates[0].emailHit

      if (cd) {
        const linked = await database('members').where('clubdesk_id', cd.cdid)
          .first('id', 'first_name', 'last_name')
        return {
          ...base,
          status: 'match_unlinked',
          clubdesk_id: cd.cdid,
          clubdesk_name: `${(cd.vorname || '').trim()} ${(cd.nachname || '').trim()}`.trim() || null,
          clubdesk_email: cd.email,
          ambiguous,
          duplicate_of: linked && linked.id !== member.id
            ? { id: linked.id, name: `${linked.first_name || ''} ${linked.last_name || ''}`.trim() }
            : null,
        }
      }

      if (member.clubdesk_pushed_at) {
        return { ...base, status: 'pushed_pending', pushed_at: member.clubdesk_pushed_at }
      }
      return { ...base, status: 'not_in_clubdesk' }
  }

  router.get('/clubdesk-registration-status', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const regId = Number(String(req.query.registration_id || '').trim())
      if (!Number.isInteger(regId)) return res.status(400).json({ error: 'registration_id required' })
      const reg = await database('registrations').where('id', regId)
        .first('id', 'email', 'vorname', 'nachname', 'status', 'member')
      if (!reg) return res.status(404).json({ error: 'Registration not found' })
      return res.json(await cdStatusForRegistration(reg))
    } catch (err) {
      log.error({ msg: `clubdesk-registration-status: ${err.message}`, endpoint: 'clubdesk-registration-status', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // Batch variant for the Anmeldungen OVERVIEW: one call resolves the ClubDesk
  // status badge for every approved registration in the table (the per-row GET
  // stays for the expanded zone's fresh check before actions).
  router.post('/clubdesk-registration-status/batch', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const ids = Array.isArray(req.body?.registration_ids)
        ? req.body.registration_ids.map(Number).filter((n) => Number.isInteger(n)).slice(0, 200)
        : []
      if (!ids.length) return res.status(400).json({ error: 'registration_ids required' })
      const regs = await database('registrations').whereIn('id', ids)
        .select('id', 'email', 'vorname', 'nachname', 'status', 'member')
      const statuses = {}
      for (const reg of regs) {
        statuses[reg.id] = await cdStatusForRegistration(reg)
      }
      return res.json({ statuses })
    } catch (err) {
      log.error({ msg: `clubdesk-registration-status/batch: ${err.message}`, endpoint: 'clubdesk-registration-status/batch', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── ClubDesk drift (Data Health) ────────────────────────────────────────────
  // Linked members whose wiedisync PUSH-SCOPE contact data no longer matches the
  // ClubDesk snapshot. Catches every edit path that does NOT set the dirty flag
  // (Data Explorer, finance/billing edits, approval backfills, raw items-API) —
  // the /clubdesk-update profile path already flags itself. Compared fields =
  // the sync-up contact scope plus names (names are compared for VISIBILITY
  // only — since 2026-07-08 update rows are [Id]-keyed and name-less, so a name
  // conflict shown here is informational and reconciles only via a manual edit
  // or the sync-down, never via a push). A field counts as drift only when the
  // WIEDISYNC side is non-empty (wiedisync is authoritative once filled — the
  // sync-down fill-only COALESCE in import-clubdesk-csv.mjs encodes the same
  // rule); wiedisync-empty + ClubDesk-non-empty is reported as blank_risk
  // instead, because pushing that member would send an empty cell. (Spike
  // 2026-07-08: ClubDesk provably IGNORES empty cells on import — blank_risk
  // stays as defense-in-depth on the legal register.)
  // Snapshot-based: "ClubDesk says" = as of the last sync-down.
  const driftNorm = (v) => String(v ?? '').trim()
  const driftLower = (v) => driftNorm(v).toLowerCase()
  const driftPhone = (v) => {
    const d = String(v ?? '').replace(/\D/g, '')
    // Equate +41 79…, 0041 79…, 079… — compare the last 9 digits (CH format).
    return d.length > 9 ? d.slice(-9) : d
  }
  const driftDateCd = (v) => {
    const m = String(v ?? '').trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''
  }
  const driftDateMember = (v) => {
    if (!v) return ''
    const iso = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : ''
  }

  async function computeClubdeskDrift(memberIds = null) {
    // alias → ISO code, both vocabularies in one map: it is what lets the
    // nationality comparison below ask "same country?" instead of "same
    // spelling?". Loaded once per call; the table is ~small and static.
    const countryAlias = new Map()
    try {
      for (const a of await database('country_name_aliases').select('alias', 'code')) {
        countryAlias.set(String(a.alias || '').trim().toLowerCase(), String(a.code || '').trim().toUpperCase())
      }
    } catch { /* no alias table → fall back to string compare, as before */ }
    // clubdesk_people lacks adresse/plz/ort/telefon_privat → dedupe the raw
    // per-group staging table ourselves (contact fields are identical across a
    // contact's group rows, so any row per clubdesk_id works).
    const params = []
    let memberFilter = ''
    if (Array.isArray(memberIds) && memberIds.length) {
      memberFilter = `AND m.id = ANY(?)`
      params.push(memberIds)
    }
    const res = await database.raw(`
      SELECT m.id, m.first_name, m.last_name, m.email, m.phone, m.adresse, m.plz, m.ort,
             m.birthdate, m.sex, m.iban, m.anrede, m.nationalitaet, m.ahv_nummer,
             m.federation_of_origin, m.trainer_licences,
             m.register_status, m.eintritt, m.austritt, m.beitragskategorie,
             m.clubdesk_id, m.clubdesk_push_pending,
             cd.vorname AS cd_vorname, cd.nachname AS cd_nachname, cd.email AS cd_email,
             cd.email_alternativ AS cd_email_alt, cd.telefon_privat AS cd_tel_priv,
             cd.telefon_mobil AS cd_tel_mob, cd.adresse AS cd_adresse, cd.plz AS cd_plz,
             cd.ort AS cd_ort, cd.geburtsdatum AS cd_geburtsdatum, cd.geschlecht AS cd_geschlecht,
             cd.iban AS cd_iban, cd.anrede AS cd_anrede, cd.nationalitaet AS cd_nationalitaet,
             cd.ahv_nummer AS cd_ahv_nummer, cd.federation_of_origin AS cd_federation_of_origin,
             cd.trainer_lizenz AS cd_trainer_lizenz,
             cd.status AS cd_status, cd.eintritt AS cd_eintritt, cd.austritt AS cd_austritt,
             cd.beitragskategorie AS cd_kategorie,
             cd.gast AS cd_gast
      FROM members m
      JOIN (
        SELECT DISTINCT ON (BTRIM(clubdesk_id)) BTRIM(clubdesk_id) AS cdid, vorname, nachname,
               email, email_alternativ, telefon_privat, telefon_mobil, adresse, plz, ort,
               geburtsdatum, geschlecht, iban, anrede, nationalitaet, ahv_nummer,
               federation_of_origin, trainer_lizenz, status, eintritt, austritt, gast,
               beitragskategorie
        FROM clubdesk_export
        WHERE NULLIF(BTRIM(clubdesk_id), '') IS NOT NULL
        ORDER BY BTRIM(clubdesk_id), row_id
      ) cd ON cd.cdid = m.clubdesk_id
      WHERE m.clubdesk_id IS NOT NULL ${memberFilter}
      ORDER BY m.last_name, m.first_name
    `, params)
    // Same code → ClubDesk-German map the push uses, loaded ONCE for the whole
    // run: the Federation of Origin comparison has to happen on the MAPPED
    // value, since that is the string ClubDesk actually holds.
    const countryNames = await loadCountryPushNames(database)
    // Gast is DERIVED from the roster (member_teams), not a members column, so it
    // is resolved with the very SAME helper the push uses — a drift verdict that
    // could disagree with the cell buildPushCsv writes would re-flag the member
    // on every refresh and never converge.
    const guestIds = await guestMemberIdSet(database, res.rows.map((r) => r.id), getCurrentSeason())
    const candidates = []
    for (const r of res.rows) {
      // conflicts = both sides non-empty and different (per-member row in Data
      // Health); fills = wiedisync set, ClubDesk empty (aggregated per field —
      // 100+ legitimate mass-fills like `sex` would otherwise flood the page);
      // blankRisk = wiedisync empty, ClubDesk set (push would blank it — warn).
      const conflicts = []
      const fills = []
      const blankRisk = []
      const cmp = (field, wiediRaw, cdRaw, wiediNorm, cdNorm) => {
        if (wiediNorm && cdNorm) {
          if (wiediNorm !== cdNorm) conflicts.push({ field, wiedisync: driftNorm(wiediRaw), clubdesk: driftNorm(cdRaw) })
        } else if (wiediNorm) {
          fills.push({ field, wiedisync: driftNorm(wiediRaw) })
        } else if (cdNorm) {
          blankRisk.push(field)
        }
      }
      // The echo-protected variant: identical, minus the blank_risk branch.
      // /up resolves these cells to ClubDesk's OWN value when wiedisync's is
      // empty, so the push provably cannot blank them and calling the member
      // "at risk" would only drop them from every push for no reason (the IBAN
      // note below is the original statement of this rule). Declared beside
      // `cmp` because a `const` arrow cannot be called above its own line —
      // adresse/plz/ort sit between here and where it used to live.
      const cmpEcho = (field, wRaw, cRaw, wNorm, cNorm) => {
        if (wNorm && cNorm) {
          if (wNorm !== cNorm) conflicts.push({ field, wiedisync: driftNorm(wRaw), clubdesk: driftNorm(cRaw) })
        } else if (wNorm) {
          fills.push({ field, wiedisync: driftNorm(wRaw) })
        }
      }
      // ⚠ A `?` in a ClubDesk name is NOT a difference — it is a character the
      // export could not encode (2026-08-15). ClubDesk exports CP1252, and any
      // codepoint outside it (ć, ń, ł, š, ž…) is written as a literal question
      // mark by ClubDesk's own encoder. So `Curavić` in the register arrives here
      // as `Curavi?` and compared naively reads as drift forever — unfixably,
      // since names are never pushed and the register is already correct.
      //
      // Treat `?` as a single-character wildcard: if our name matches the export
      // with each `?` standing for one character, the two agree as far as this
      // lossy channel can tell, and asserting a difference would be a false
      // positive about the club's legal register. Everything else still compares
      // exactly. Verified on prod: exactly ONE contact of 1154 carries a `?`, and
      // it is the only member whose register name holds a non-CP1252 letter —
      // the others (Krawczyński, Kalaga) were created BY our push, which
      // transliterates, so they really are stored ASCII.
      const nameAgrees = (mine, cd) => {
        const a = driftLower(mine)
        const b = driftLower(cd)
        if (!a || !b) return false
        if (a === b) return true
        if (!b.includes('?')) return false
        // Escape the whole thing, then let each escaped `?` match one character.
        const rx = new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\?/g, '.')}$`)
        return rx.test(a)
      }
      if (!nameAgrees(r.first_name, r.cd_vorname)) {
        cmp('first_name', r.first_name, r.cd_vorname, driftLower(r.first_name), driftLower(r.cd_vorname))
      }
      if (!nameAgrees(r.last_name, r.cd_nachname)) {
        cmp('last_name', r.last_name, r.cd_nachname, driftLower(r.last_name), driftLower(r.cd_nachname))
      }
      // ⚠⚠ Email and phone are the two fields ClubDesk keeps in TWO columns and
      // the push writes only ONE of (`E-Mail` and `Telefon Privat`, per
      // CD_PUSH_CONTACT_HEADERS). Agreement is rightly checked against both —
      // holding the number under "Mobil" still means we agree with the register
      // — but blank_risk may never look past the column an UPDATE row writes.
      // Widening it there asserts that an empty cell would blank a value the
      // push does not touch, and that verdict DROPS THE MEMBER FROM EVERY PUSH.
      // Measured on prod 2026-08-30: both of the club's phone blank_risks were
      // exactly that (Privat empty, a number only under Mobil), and one of them
      // 409'd the entire club's sync-up.
      //
      // Phone then left blank_risk altogether, because /up now echoes ClubDesk's
      // own `Telefon Privat` back (m.phone_cd) — same guarantee as IBAN. Email
      // stays: it is the LOGIN identity, wiedisync owns it, and a member with no
      // address here is a data-quality question a human should answer, not a
      // cell to paper over.
      const em = driftLower(r.email)
      const cdEm = driftLower(r.cd_email) || driftLower(r.cd_email_alt)
      if (em && cdEm) {
        if (em !== driftLower(r.cd_email) && em !== driftLower(r.cd_email_alt)) {
          conflicts.push({ field: 'email', wiedisync: driftNorm(r.email), clubdesk: driftNorm(r.cd_email) || driftNorm(r.cd_email_alt) })
        }
      } else if (em) {
        fills.push({ field: 'email', wiedisync: driftNorm(r.email) })
      } else if (driftLower(r.cd_email)) {
        blankRisk.push('email')
      }
      // Phone matches when it equals EITHER ClubDesk number (privat or mobil).
      const ph = driftPhone(r.phone)
      const cdPhones = [driftPhone(r.cd_tel_priv), driftPhone(r.cd_tel_mob)].filter(Boolean)
      if (ph && cdPhones.length) {
        if (!cdPhones.includes(ph)) {
          conflicts.push({ field: 'phone', wiedisync: driftNorm(r.phone), clubdesk: driftNorm(r.cd_tel_priv) || driftNorm(r.cd_tel_mob) })
        }
      } else if (ph) {
        fills.push({ field: 'phone', wiedisync: driftNorm(r.phone) })
      }
      cmpEcho('adresse', r.adresse, r.cd_adresse, driftLower(r.adresse), driftLower(r.cd_adresse))
      cmpEcho('plz', r.plz, r.cd_plz, driftNorm(r.plz), driftNorm(r.cd_plz))
      cmpEcho('ort', r.ort, r.cd_ort, driftLower(r.ort), driftLower(r.cd_ort))
      // Display both sides Swiss-style (dd.mm.yyyy); compare on ISO.
      const bdIso = driftDateMember(r.birthdate)
      const bdDisp = bdIso ? `${bdIso.slice(8, 10)}.${bdIso.slice(5, 7)}.${bdIso.slice(0, 4)}` : ''
      cmp('birthdate', bdDisp, r.cd_geburtsdatum, bdIso, driftDateCd(r.cd_geburtsdatum))
      const sexCd = r.sex === 'm' ? 'männlich' : r.sex === 'f' ? 'weiblich' : ''
      cmp('sex', sexCd, r.cd_geschlecht, sexCd, driftLower(r.cd_geschlecht))
      // IBAN: conflict/fill detection only — deliberately NEVER blank_risk.
      // The /up echo-back sends ClubDesk's own IBAN when wiedisync's is empty,
      // so an empty wiedisync IBAN cannot blank the register; flagging it as
      // blank_risk would only drop the member from pushes for no reason.
      const ibanNorm = (v) => String(v ?? '').replace(/\s/g, '').toUpperCase()
      const wIban = ibanNorm(r.iban)
      const cIban = ibanNorm(r.cd_iban)
      if (wIban && cIban) {
        if (wIban !== cIban) conflicts.push({ field: 'iban', wiedisync: driftNorm(r.iban), clubdesk: driftNorm(r.cd_iban) })
      } else if (wIban) {
        fills.push({ field: 'iban', wiedisync: driftNorm(r.iban) })
      }
      // Anrede / Nationalität / AHV are echo-protected — see cmpEcho above.
      // AHV compares digits-only (dot formatting differs between the systems).
      cmpEcho('anrede', r.anrede, r.cd_anrede, driftLower(r.anrede), driftLower(r.cd_anrede))
      // ⚠ Nationality compares by CODE, not by display string (2026-08-15).
      // `members.nationalitaet` is trigger-derived from `nationalitaet_codes`
      // into OUR display name, while ClubDesk holds its own picklist spelling —
      // so "Vereinigte Staaten" and "USA" are the same country reported as a
      // conflict forever, with no sync able to resolve it (the column is
      // fill-only downward and the push echoes the register's own wording back).
      // Measured on prod: 3 of the 8 non-name conflicts were exactly this pair.
      // country_name_aliases is the table that already knows both vocabularies.
      const natMine = countryAlias.get(driftLower(r.nationalitaet)) || driftLower(r.nationalitaet)
      const natCd = countryAlias.get(driftLower(r.cd_nationalitaet)) || driftLower(r.cd_nationalitaet)
      cmpEcho('nationalitaet', r.nationalitaet, r.cd_nationalitaet, natMine, natCd)
      // Federation of Origin: wiedisync stores a code, ClubDesk a German
      // picklist string, so compare (and DISPLAY) the mapped value — same
      // computed-then-compared shape as sexCd above. Echo-protected like the
      // three fields around it → conflict-or-fill, never blank_risk. An
      // unmappable code yields '' and simply drops out of the comparison rather
      // than being reported as a conflict against ClubDesk's good value.
      const fedCd = federationCell(r.federation_of_origin, countryNames)
      cmpEcho('federation_of_origin', fedCd, r.cd_federation_of_origin, driftLower(fedCd), driftLower(r.cd_federation_of_origin))
      const ahvDigits = (v) => String(v ?? '').replace(/\D/g, '')
      cmpEcho('ahv_nummer', r.ahv_nummer, r.cd_ahv_nummer, ahvDigits(r.ahv_nummer), ahvDigits(r.cd_ahv_nummer))
      // ── The register triple (migration 302) ──────────────────────────────
      // Echo-protected like the fields above → conflict-or-fill, never
      // blank_risk: registerCell sends ClubDesk's own cell back whenever
      // wiedisync's is empty or unchanged, so an empty wiedisync value cannot
      // blank the register and must not drop the member from every push.
      //
      // This comparison is what makes "the register wins once the push has
      // landed" observable rather than merely intended: a status changed IN
      // ClubDesk shows up here as a CONFLICT the moment the two disagree,
      // instead of being quietly overwritten on some later push.
      cmpEcho('register_status', r.register_status, r.cd_status,
        driftLower(r.register_status), driftLower(r.cd_status))
      // Beitragskategorie became a gated register cell on 2026-08-14, so its
      // divergence has to be VISIBLE for the same reason the status's is: the
      // push only carries it when the member's change names it, and until then
      // the two sides can sit apart indefinitely. Compared on the MAPPED name —
      // that is what the register holds. Echo-protected → conflict-or-fill,
      // never blank_risk. Measured on prod the day this shipped: 0 conflicts
      // across all 672 linked active members, so this adds no noise.
      const katW = mapKategorie(r.beitragskategorie)
      cmpEcho('beitragskategorie', katW, r.cd_kategorie,
        driftLower(katW), driftLower(r.cd_kategorie))
      // Dates display Swiss-style and compare on ISO — the same split birthdate
      // uses above, because ClubDesk's cell is dd.mm.yyyy text and wiedisync's
      // is a real date column.
      for (const [field, memberVal, cdVal] of [
        ['eintritt', r.eintritt, r.cd_eintritt],
        ['austritt', r.austritt, r.cd_austritt],
      ]) {
        const iso = driftDateMember(memberVal)
        const disp = iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : ''
        cmpEcho(field, disp, cdVal, iso, driftDateCd(cdVal))
      }
      // Trainer Lizenz: compare CODE SETS, not the rendered strings. ClubDesk's
      // cell is hand-editable free text, so "J+S, B", "B, J+S" and "j+s / b" all
      // mean the same thing and must not report as a conflict — parsing both
      // sides through parseTrainerLicenceCell normalizes order, case and
      // separators in one step. DISPLAY still shows the rendered wording so the
      // admin sees what would actually land in the cell. Echo-protected like the
      // fields above → conflict-or-fill, never blank_risk.
      const trainerW = trainerLicenceCell(r.trainer_licences)
      cmpEcho(
        'trainer_licences', trainerW, r.cd_trainer_lizenz,
        parseTrainerLicenceCodes(r.trainer_licences).join(','),
        parseTrainerLicenceCell(r.cd_trainer_lizenz),
      )
      // Gast: wiedisync-owned and TOTAL (gastCell always yields Ja or Nein), so
      // plain cmp is safe — the blank_risk branch is unreachable by construction,
      // and a member who stops (or starts) being a guest surfaces as a normal
      // CONFLICT the admin can flag + push. This is the whole reason the column
      // is in the drift set: without it the 2026-07-27 backfill would have been
      // a one-off snapshot that silently rots at the next roster turnover.
      const gastW = gastCell(guestIds.has(Number(r.id)))
      cmp('gast', gastW, r.cd_gast, driftLower(gastW), driftLower(r.cd_gast))
      if (!conflicts.length && !fills.length) continue
      candidates.push({
        member_id: r.id,
        member_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        clubdesk_id: r.clubdesk_id,
        pending: r.clubdesk_push_pending === true,
        conflicts,
        fills,
        blank_risk: blankRisk,
      })
    }
    return candidates
  }

  router.get('/clubdesk-drift', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const all = await computeClubdeskDrift()
      // Per-member rows only for real CONFLICTS; fill-only members (wiedisync
      // has data ClubDesk lacks) are aggregated per field so 100+ legit fills
      // (e.g. sex, set only in wiedisync) don't flood Data Health. Members
      // already marked for sync-up are excluded from both.
      const active = all.filter((c) => !c.pending)
      const candidates = active.filter((c) => c.conflicts.length)
      // blank_risk members are EXCLUDED from the bulk member_ids: their push
      // would send empty cells for fields ClubDesk still owns (spike 2026-07-08:
      // empty cells are provably no-ops on import; the exclusion stays as
      // defense-in-depth on the legal register). They self-heal:
      // the next sync-down fills the empty wiedisync fields from ClubDesk,
      // the risk disappears, and they join the bulk. at_risk = how many are
      // currently held back per field.
      const fills = {}
      for (const c of active) {
        if (c.conflicts.length) continue
        for (const f of c.fills) {
          if (!fills[f.field]) fills[f.field] = { count: 0, member_ids: [], at_risk: 0 }
          if (c.blank_risk.length) {
            fills[f.field].at_risk++
          } else {
            fills[f.field].count++
            fills[f.field].member_ids.push(c.member_id)
          }
        }
      }
      return res.json({ candidates, fills })
    } catch (err) {
      log.error({ msg: `clubdesk-drift: ${err.message}`, endpoint: 'clubdesk-drift', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Fee-rule check (Data Health) ────────────────────────────────────────────
  // "Does what the register bills this member match what the club's own rules
  // say they owe?" Three rule families, confirmed by the user 2026-08-13:
  //
  //   free     Ehrenmitglied / Vorstand / coach → CHF 0. A team responsible is
  //            NOT a coach and is billed normally (user 2026-08-13).
  //            ⚠ COACHING WINS over playing (user decision 2026-08-13): a
  //            player-coach is free even though they hold a paid player
  //            category. That is NOT what the register does today — 6 of the 7
  //            player-coaches on prod are billed 380–520 — so these surface as
  //            findings on purpose, for a human to act on.
  //   passiv   register_status 'Passivmitglied' → the Passiv category, CHF 40.
  //   billable everybody else → the register's amount must equal what
  //            feeBreakdown() derives from their category.
  //
  // ⚠ REPORT ONLY. The register's Mitgliederbeitrag is the club's real decision
  // (a per-person cell with hand-set exceptions), not this engine's derivation —
  // see the CD_BEITRAG_MAP header and registerCell(). Nothing here writes, and
  // no "fix all" is offered: a mismatch is a question for the treasurer, and the
  // answer is as often "correct the category" as "correct the amount".
  //
  // ⚠ Zwischenjahr (28 members on prod) is DELIBERATELY NOT EVALUATED. Whether a
  // gap year owes a reduced fee or nothing at all is an open question with the
  // treasurer (2026-08-13); the two 'mit Abzug' categories are held by exactly
  // three contacts, all of them Zwischenjahr, all with an EMPTY register amount,
  // so there is no historical figure to infer either. Guessing would flag 28
  // correct rows. They are counted and reported as `not_evaluated` instead.
  //
  // ⚠ Honorary members already in the Ehrenmitglieder GROUP are skipped by the
  // `free` rule: /clubdesk-group-sync's honorary_drift already reports exactly
  // that pair (in the group, not on 'Gratis'), and two surfaces for one fact is
  // how the retired group-count rows in dataHealthChecks.ts went stale.
  const FEE_FREE_CATEGORIES = ['Gratis', 'Kein Beitrag']
  const FEE_PASSIV_CATEGORY = 'Passivmitglied'
  const FEE_PASSIV_AMOUNT = 40
  /** Statuses whose fee rule is still undecided — counted, never flagged. */
  const FEE_UNDECIDED_STATUSES = ['Zwischenjahr']

  /** ClubDesk's Mitgliederbeitrag cell → number, or null when the cell is empty.
   *  An empty cell is "the register has not said", which is a DIFFERENT finding
   *  from "the register says the wrong number" — never coerce it to 0. */
  const feeCellNum = (v) => {
    const s = String(v ?? '').trim()
    if (!s) return null
    const n = Number(s.replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : null
  }

  async function computeFeeRuleChecks() {
    const res = await database.raw(`
      WITH cd AS (
        SELECT DISTINCT ON (BTRIM(clubdesk_id)) BTRIM(clubdesk_id) AS cdid,
               mitgliederbeitrag, beitragskategorie, status, gruppen_bracketed
          FROM clubdesk_export
         WHERE NULLIF(BTRIM(clubdesk_id), '') IS NOT NULL
         ORDER BY BTRIM(clubdesk_id), row_id
      )
      SELECT m.id, m.first_name, m.last_name, m.register_status, m.beitragskategorie,
             m.birthdate, m.scorer_vb, m.otr1_bb, m.otr2_bb, m.otn1_bb, m.otn2_bb,
             m.fee_base_override, m.fee_surcharge_override, m.fee_discount,
             m.fee_discount_pct, m.fee_discount_reason, m.clubdesk_id,
             cd.mitgliederbeitrag AS cd_betrag, cd.beitragskategorie AS cd_kat,
             EXISTS (
               SELECT 1 FROM unnest(string_to_array(cd.gruppen_bracketed, ',')) g
                WHERE BTRIM(g) = 'Ehrenmitglieder'
             ) AS in_honorary_group
        FROM members m
        JOIN cd ON cd.cdid = m.clubdesk_id
       WHERE m.kscw_membership_active = true
       ORDER BY m.last_name, m.first_name`)
    // The guest reduction is part of the fee, so it has to come from the SAME
    // helper the push and the dues run use — a guest resolved differently here
    // would report every guest as a mismatch forever.
    const guestIds = await guestMemberIdSet(database, res.rows.map((r) => r.id), getCurrentSeason())
    // The SAME helper the dues run waives on, so the check can never report
    // "should be free" for somebody the run then bills — see resolveFeeWaivers.
    const waivers = await resolveFeeWaivers(database, res.rows.map((r) => r.id))

    const findings = []
    let notEvaluated = 0
    let checked = 0
    for (const r of res.rows) {
      const kat = String(r.beitragskategorie || '').trim()
      const registerAmount = feeCellNum(r.cd_betrag)
      const waiverReason = waivers.get(Number(r.id)) || null
      const isFree = waiverReason !== null
      const row = {
        member_id: r.id,
        member_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        register_status: r.register_status || null,
        category: kat || null,
        register_amount: registerAmount,
        expected: null,
        // Why this member is expected to be free, so the row explains itself
        // rather than making the reader join three tables in their head.
        reason: waiverReason,
      }

      if (isFree) {
        // The group half of the honorary axis belongs to honorary_drift.
        if (r.in_honorary_group === true && r.register_status === 'Ehrenmitglied') continue
        checked++
        const override = overrideNum(r.fee_base_override)
        const billed = !FEE_FREE_CATEGORIES.includes(kat)
          || (registerAmount !== null && registerAmount !== 0)
          // A non-zero base override bills them in the dues run even when the
          // category says Gratis — the case the honorary check already learned.
          || (override !== null && override !== 0)
        if (billed) findings.push({ ...row, kind: 'free_but_billed', expected: 0 })
        continue
      }
      if (FEE_UNDECIDED_STATUSES.includes(r.register_status || '')) { notEvaluated++; continue }
      checked++

      if (r.register_status === FEE_PASSIV_CATEGORY) {
        if (kat !== FEE_PASSIV_CATEGORY) {
          findings.push({ ...row, kind: 'passiv_wrong_category', expected: FEE_PASSIV_AMOUNT })
        } else if (registerAmount === null) {
          findings.push({ ...row, kind: 'no_register_amount', expected: FEE_PASSIV_AMOUNT })
        } else if (registerAmount !== FEE_PASSIV_AMOUNT) {
          findings.push({ ...row, kind: 'amount_mismatch', expected: FEE_PASSIV_AMOUNT })
        }
        continue
      }
      if (!kat) { findings.push({ ...row, kind: 'no_category' }); continue }
      // The member's own overrides apply — feeBreakdown is the one engine, and a
      // re-priced member must not report as a mismatch against the map amount.
      const fee = feeBreakdown(kat, r, { isGuest: guestIds.has(Number(r.id)) })
      if (!fee) { findings.push({ ...row, kind: 'unmapped_category' }); continue }
      if (registerAmount === null) {
        findings.push({ ...row, kind: 'no_register_amount', expected: fee.amount })
      } else if (registerAmount !== fee.amount) {
        findings.push({ ...row, kind: 'amount_mismatch', expected: fee.amount })
      }
    }
    return { findings, checked, not_evaluated: notEvaluated, undecided_statuses: FEE_UNDECIDED_STATUSES }
  }

  router.get('/clubdesk-fee-rules', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      return res.json(await computeFeeRuleChecks())
    } catch (err) {
      log.error({ msg: `clubdesk-fee-rules: ${err.message}`, endpoint: 'clubdesk-fee-rules', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // Mark drifted members for the next sync-up push: sets the dirty flag +
  // stores the field diff (old = ClubDesk, new = wiedisync) so the sync-up
  // modal echoes exactly what will change. Diffs are recomputed server-side —
  // the client's list may be stale. The actual push still goes through the
  // sync-up modal (preview → confirm → dispatcher), nothing moves here.
  router.post('/clubdesk-drift/flag', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const ids = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(Number).filter((n) => Number.isInteger(n)) : []
      if (!ids.length) return res.status(400).json({ error: 'member_ids required' })
      const computed = await computeClubdeskDrift(ids)
      if (!computed.length) return res.status(409).json({ error: 'No drift found for these members — refresh Data health', code: 'no_drift' })
      // Refuse members whose push would blank ClubDesk-owned data (empty
      // wiedisync field + non-empty ClubDesk value): buildPushCsv always sends
      // the full row. (Spike 2026-07-08: ClubDesk provably ignores empty cells
      // on import, but this refusal stays as defense-in-depth on the register.)
      // These heal via sync-down (fills the empty wiedisync fields), so the
      // admin's fix is "run sync down first", not an override.
      const candidates = computed.filter((c) => !c.blank_risk.length)
      const skipped = computed.length - candidates.length
      if (!candidates.length) {
        return res.status(409).json({ error: 'Push would blank ClubDesk data (member has empty fields ClubDesk still owns) — fill those fields in wiedisync, or accept the pending fill proposals; a sync-down cannot do it for a member already flagged for a push', code: 'blank_risk' })
      }
      for (const c of candidates) {
        const changes = [
          ...c.conflicts.map((d) => ({ field: d.field, old_value: d.clubdesk, new_value: d.wiedisync })),
          ...c.fills.map((d) => ({ field: d.field, old_value: null, new_value: d.wiedisync })),
        ]
        await database('members').where('id', c.member_id).update({
          clubdesk_push_pending: true,
          clubdesk_push_changes: JSON.stringify(changes),
        })
        await writeUserLog(database, log, {
          accountability: req.accountability, action: 'update',
          collection: 'members', recordId: c.member_id,
          data: { kind: 'clubdesk_drift_flag', fields: changes.map((d) => d.field) },
        })
      }
      return res.json({ flagged: candidates.length, skipped_blank_risk: skipped })
    } catch (err) {
      log.error({ msg: `clubdesk-drift/flag: ${err.message}`, endpoint: 'clubdesk-drift/flag', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Sync-down proposals: review before anything reaches `members` ────────────
  // The sync-down no longer writes (migration 321 + import-clubdesk-csv.mjs). It
  // stages rows in clubdesk_sync_proposals and these two routes are how a
  // superadmin resolves them.
  //

  router.get('/clubdesk-sync/proposals', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const rows = await database('clubdesk_sync_proposals as p')
        .leftJoin('members as m', 'm.id', 'p.member_id')
        .where('p.status', 'pending')
        .select(
          'p.id', 'p.member_id', 'p.clubdesk_id', 'p.field', 'p.current_value',
          'p.proposed_value', 'p.rule', 'p.payload', 'p.detected_at',
          'm.first_name', 'm.last_name',
        )
        .orderBy([{ column: 'p.rule' }, { column: 'm.last_name' }, { column: 'p.field' }])
      const counts = {}
      for (const r of rows) counts[r.rule] = (counts[r.rule] || 0) + 1
      return res.json({
        proposals: rows.map((r) => ({
          id: r.id,
          member_id: r.member_id,
          member_name: r.member_id
            ? `${r.first_name || ''} ${r.last_name || ''}`.trim()
            // A create proposal has no member row yet — the name rides in payload
            // because clubdesk_export is TRUNCATEd on every run.
            : [r.payload?.first_name, r.payload?.last_name].filter(Boolean).join(' ').trim(),
          clubdesk_id: r.clubdesk_id,
          field: r.field,
          current_value: r.current_value,
          proposed_value: r.proposed_value,
          rule: r.rule,
          email: r.payload?.email ?? null,
          detected_at: r.detected_at,
        })),
        counts,
        total: rows.length,
      })
    } catch (err) {
      log.error({ msg: `clubdesk-sync/proposals: ${err.message}`, endpoint: 'clubdesk-sync/proposals', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  /**
   * Stage a `conflict` proposal for every live drift conflict (migration 338).
   *
   * This is the half of the merge that moves decisions out of the "Needs
   * syncing" board and into the queue that can remember an answer. A drift row
   * is recomputed from `members` vs `clubdesk_export` on every read, so it has
   * no memory: "Keep ours" queues a push and the row returns unchanged until
   * that push lands, and there has never been a way to take ClubDesk's side at
   * all. As a proposal it gets both verbs and a durable tombstone.
   *
   * ⚠ Runs off computeClubdeskDrift() rather than a SQL pass next to the other
   * four rules — see migration 338 for why restating that normalisation in SQL
   * would create a third opinion.
   *
   * ⚠ Two exclusions, both deliberate:
   *   names — the push CSV is name-less, so neither direction can act; they stay
   *           a `name_drift` status, which is also how a mis-link surfaces.
   *   gast  — wiedisync owns rosters and ClubDesk's Gast cell is derived from
   *           our own push, so accepting it would let a round-trip overwrite its
   *           own source. It is not in PROPOSAL_COLUMNS, and the whitelist test
   *           below is what enforces that rather than a second list to keep.
   */
  /**
   * Runaway guard, same reasoning as GROUP_FIX_CAP: past this, the INPUTS are
   * wrong and the correct response is never to turn the symptom into a work
   * list. Prod carries 3 conflicts today and its historic high was 8; a stale or
   * half-loaded clubdesk_export makes hundreds of members "disagree" at once,
   * and dev proves the shape — its nightly PII scrub rewrites members.email to
   * member_143@devsink.invalid and clubdesk_export.email to
   * scrub_8dfa…@devsink.invalid, two different schemes, so 698 of its 700
   * conflicts are email and none of them are real.
   *
   * ⚠ It matters more here than it looks, because pending proposals BLOCK step 2
   * of the sync path: an uncapped flood would not just be noise, it would park
   * the whole run behind hundreds of decisions nobody can make.
   *
   * ⚠ Stages NOTHING rather than the first N. A partial queue is worse than
   * none — you would decide an arbitrary slice while the rest vanished silently.
   */
  const CONFLICT_STAGING_CAP = 150

  async function stageConflictProposals() {
    const drift = await computeClubdeskDrift()
    const NAME_FIELDS = new Set(['first_name', 'last_name'])
    let wanted = []
    for (const c of drift) {
      for (const d of c.conflicts) {
        if (NAME_FIELDS.has(d.field)) continue
        // The accept path's whitelist IS the gate: a field it cannot write must
        // not be offered as a decision.
        if (!PROPOSAL_COLUMNS[d.field]) continue
        wanted.push({
          member_id: c.member_id,
          clubdesk_id: c.clubdesk_id,
          field: d.field,
          current_value: d.wiedisync ?? null,
          proposed_value: d.clubdesk ?? null,
          rule: 'conflict',
        })
      }
    }
    if (!wanted.length) return { staged: 0, considered: 0, capped: false }

    // ⚠⚠ A field with a STAGED, UNPUSHED change is not a disagreement to decide —
    // it is a push waiting to happen, and ClubDesk simply has not been told yet.
    // Staging it as a conflict asks the operator to adjudicate their own pending
    // edit against the value it is about to replace, and the only correct answer
    // ("refuse") is the one that reads like undoing the work. Worse, ACCEPTING is
    // offered, and accept writes ClubDesk's value over the edit that was queued.
    // Surfaced 08.09.2026: six departures were staged (register_status + austritt)
    // and the very next sync-down proposed reverting all six to Aktivmitglied.
    // The item is not lost by skipping it — the member stays
    // `clubdesk_push_pending`, so it is counted by step 3 instead of step 2, which
    // is where it belongs. If the push is refused or the value comes back
    // different afterwards, the next detection stages it for real.
    const pushStaged = new Map()
    for (const r of await database('members')
      .whereIn('id', [...new Set(wanted.map((w) => w.member_id))])
      .where('clubdesk_push_pending', true)
      .select('id', 'clubdesk_push_changes')) {
      pushStaged.set(r.id, changedPushFields(r.clubdesk_push_changes))
    }
    if (pushStaged.size) {
      const before = wanted.length
      wanted = wanted.filter((w) => !pushStaged.get(w.member_id)?.has(w.field))
      // Counted BEFORE the cap, so a queue of pending pushes can never push a
      // normal run over it and stage nothing at all.
      if (before !== wanted.length) {
        log.info(`ClubDesk conflict staging: skipped ${before - wanted.length} field(s) with an unpushed change already staged`)
      }
      if (!wanted.length) return { staged: 0, considered: 0, capped: false }
    }

    if (wanted.length > CONFLICT_STAGING_CAP) {
      // Loud, not silent: this is the one outcome where "0 staged" would read as
      // "nothing to decide" while the truth is "everything disagrees".
      log.warn(`ClubDesk conflict staging: ${wanted.length} conflicts exceed the cap of ${CONFLICT_STAGING_CAP} — staged none (clubdesk_export is probably stale or half-loaded)`)
      return { staged: 0, considered: wanted.length, capped: true }
    }

    // ⚠⚠ Read-then-insert, NOT insert-and-count. `.onConflict().ignore()` drops
    // RETURNING on knex 3.1 (the version in the container), so an insert that
    // worked reports zero rows — a write that lies about having done nothing is
    // never re-run. The existing rows are read inside the transaction and only
    // genuinely new ones are inserted; ON CONFLICT stays purely as a race
    // backstop against a concurrent detection run.
    const memberIds = [...new Set(wanted.map((w) => w.member_id))]
    return await database.transaction(async (trx) => {
      const seen = await trx('clubdesk_sync_proposals')
        .whereIn('member_id', memberIds)
        .whereIn('status', ['pending', 'refused'])
        .select('member_id', 'field', 'proposed_value', 'status')
      // A PENDING proposal for this (member, field) blocks a second one whatever
      // its value — the partial unique says so, and asking the same question
      // twice is the thing that index exists to prevent. A REFUSED one blocks
      // only its own value, so a later, genuinely different ClubDesk value still
      // reaches the operator.
      // `|` is unambiguous here and greppable: member_id is numeric and a field
      // name is [a-z_]+, so neither can contain one, and the free-text value is
      // always last.
      const pending = new Set(seen.filter((r) => r.status === 'pending')
        .map((r) => `${r.member_id}|${r.field}`))
      const refused = new Set(seen.filter((r) => r.status === 'refused')
        .map((r) => `${r.member_id}|${r.field}|${r.proposed_value ?? ''}`))
      const fresh = wanted.filter((w) =>
        !pending.has(`${w.member_id}|${w.field}`)
        && !refused.has(`${w.member_id}|${w.field}|${w.proposed_value ?? ''}`))
      if (!fresh.length) return { staged: 0, considered: wanted.length, capped: false }
      await trx('clubdesk_sync_proposals').insert(fresh).onConflict().ignore()
      return { staged: fresh.length, considered: wanted.length, capped: false }
    })
  }

  // Called by the sync path the moment a sync-down settles (and available on its
  // own). Deliberately a POST and never folded into the proposals GET: staging
  // writes rows, and a list endpoint that mutates on read is how a refresh turns
  // into a side effect.
  router.post('/clubdesk-sync/proposals/detect', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const { staged, considered, capped } = await stageConflictProposals()
      // ⚠ Stamped even when nothing was staged (migration 339). The watermark
      // means "drift has been examined for the current sync-down", not "rows
      // were written" — the scheduled hook compares it against
      // down_last_success_at, so a run that legitimately finds nothing has to
      // close the window or the hook re-examines the same sync every tick.
      await database('clubdesk_member_sync').where('id', 1)
        .update({ conflicts_staged_at: new Date() })
      if (staged > 0) {
        await writeUserLog(database, log, {
          accountability: req.accountability, action: 'create',
          collection: 'clubdesk_sync_proposals', recordId: null,
          data: { kind: 'clubdesk_conflict_detect', staged, considered },
        })
      }
      // ⚠ The watermark is stamped even when the cap refused everything. Re-running
      // the same computation against the same export every 15 minutes would hit
      // the same cap; the next sync-down is what can actually change the answer.
      return res.json({ staged, considered, capped: capped === true, cap: CONFLICT_STAGING_CAP })
    } catch (err) {
      log.error({ msg: `clubdesk conflict detect: ${err.message}`, endpoint: 'clubdesk-sync/proposals/detect', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // Accept → ClubDesk's value is written to `members` (or the member is created).
  // Refuse → ours stands, the proposal becomes a tombstone so detection never
  // asks again, and — when we actually hold a value to assert — the member is
  // flagged so the next sync-up corrects ClubDesk instead of leaving the two
  // systems knowingly divergent.
  router.post('/clubdesk-sync/proposals/decide', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const decision = String(req.body?.decision || '')
      if (decision !== 'accept' && decision !== 'refuse') {
        return res.status(400).json({ error: 'decision must be accept or refuse' })
      }
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
        .map(Number).filter(Number.isInteger)
      if (!ids.length) return res.status(400).json({ error: 'ids required' })

      const rows = await database('clubdesk_sync_proposals')
        .whereIn('id', ids).andWhere('status', 'pending').select('*')
      if (!rows.length) return res.status(409).json({ error: 'Nothing left to decide', code: 'already_decided' })

      // ⚠ Status and Austritt are ONE fact, and accepting them is therefore
      // ORDER-DEPENDENT: an exit date under a still-active status aborts on
      // members_austritt_needs_departed_status (migration 302). Applying every
      // register_status row of the batch first makes a multi-select accept
      // order-independent; the single-row accept carries its sibling along
      // below. Ordering only — no row is added, dropped or reinterpreted.
      rows.sort((a, b) => (b.field === 'register_status') - (a.field === 'register_status'))

      const actor = await resolveActingUser(req)
      const stamp = { decided_at: new Date(), decided_by_name: actor.name, decided_by_email: actor.email }
      let applied = 0, skipped = 0, flagged = 0

      // Name → ISO code, for the federation coercion below. Loaded once for the
      // whole batch and only when the batch actually contains one, so an accept
      // of anything else costs no extra query.
      const coerceCtx = {}
      if (decision === 'accept' && rows.some((p) => p.field === 'federation_of_origin')) {
        coerceCtx.countryCodes = await loadCountryCodeLookup(database)
      }

      for (const p of rows) {
        if (decision === 'refuse') {
          await database('clubdesk_sync_proposals').where('id', p.id)
            .update({ status: 'refused', ...stamp })
          // Only assert upward when we actually hold a value. Refusing a FILL
          // means "we are deliberately empty" — pushing that would ask ClubDesk to
          // blank its own cell, which the push refuses to do anyway (it echoes the
          // register's value back), so it would set a pending flag with nothing to
          // send AND suppress this member's other proposals until it cleared.
          if (p.member_id && String(p.current_value ?? '').trim()) {
            // ⚠⚠ MERGE, never replace. This used to assign a single-element array,
            // which silently dropped every other field already staged on that
            // member — and `clubdesk_push_changes` is not bookkeeping, it is the
            // LICENCE the sync-up needs to write a register cell at all
            // (registerCell / CD_REGISTER_FIELDS). Concretely (08.09.2026): six
            // departures staged `register_status` + `austritt` together, the next
            // sync-down proposed reverting the status, and refusing that proposal
            // would have rewritten the array to `register_status` alone — leaving
            // the exit date set on our side and unpushable forever. Same
            // filter-then-append the members.items.update hook uses.
            const prev = await database('members').where('id', p.member_id).first('clubdesk_push_changes')
            let changes = []
            try {
              changes = Array.isArray(prev?.clubdesk_push_changes) ? prev.clubdesk_push_changes
                : (prev?.clubdesk_push_changes ? JSON.parse(prev.clubdesk_push_changes) : [])
            } catch { changes = [] }
            changes = changes.filter((c) => c?.field !== p.field)
            changes.push({ field: p.field, old_value: p.proposed_value, new_value: p.current_value })
            await database('members').where('id', p.member_id).update({
              clubdesk_push_pending: true,
              clubdesk_push_changes: JSON.stringify(changes),
            })
            flagged++
          }
          await writeUserLog(database, log, {
            accountability: req.accountability, action: 'update',
            collection: 'members', recordId: p.member_id,
            data: { kind: 'clubdesk_proposal_refuse', field: p.field, rule: p.rule, refused_value: p.proposed_value },
          })
          applied++
          continue
        }

        // ── accept ──
        if (p.rule === 'create') {
          // The contact may have been linked (or created) since detection ran.
          const taken = await database('members')
            .whereRaw('BTRIM(clubdesk_id) = ?', [String(p.clubdesk_id).trim()]).first('id')
          if (taken) {
            await database('clubdesk_sync_proposals').where('id', p.id)
              .update({ status: 'accepted', ...stamp })
            skipped++
            continue
          }
          const [created] = await database('members').insert({
            first_name: p.payload?.first_name || '',
            last_name: p.payload?.last_name || '',
            email: p.payload?.email || '',
            clubdesk_id: String(p.clubdesk_id).trim(),
          }).returning('id')
          const newId = typeof created === 'object' ? created.id : created
          await database('clubdesk_sync_proposals').where('id', p.id)
            .update({ status: 'accepted', member_id: newId, ...stamp })
          await writeUserLog(database, log, {
            accountability: req.accountability, action: 'create',
            collection: 'members', recordId: newId,
            data: { kind: 'clubdesk_proposal_accept_create', clubdesk_id: p.clubdesk_id },
          })
          applied++
          continue
        }

        const coerced = coerceProposalValue(p.field, p.proposed_value, coerceCtx)
        if (!coerced.ok) {
          // Not a column we allow, or a value that no longer parses. Left pending
          // on purpose: silently discarding it would hide a detection bug. The UI
          // surfaces the count as a warning toast, so it is not silent to a human
          // either.
          skipped++
          continue
        }
        const patch = { [p.field]: coerced.value }
        // ⚠ Status and Austritt are ONE fact. members_austritt_needs_departed_status
        // (migration 302) rejects an exit date under a non-departed status, so
        // accepting a status the register no longer calls departed has to clear the
        // date in the same statement or the UPDATE aborts.
        if (p.field === 'register_status' && !DEPARTED_STATUSES.includes(coerced.value)) {
          patch.austritt = null
        }
        // The mirror image, and the one the UI can actually reach: accepting an
        // exit date on a member we still call active. Detection never raises an
        // `austritt` proposal unless the REGISTER already calls them departed
        // (import-clubdesk-csv.mjs gates it on cd_reg_status), so the sibling
        // register_status proposal exists in exactly the cases that would abort
        // — and the register's own status is the only defensible answer to
        // "departed how". A NULL status is left alone: the constraint permits a
        // date under it, and NULL means "wiedisync has never been told".
        let sibling = null
        if (p.field === 'austritt') {
          const held = (await database('members').where('id', p.member_id).first('register_status'))?.register_status ?? null
          if (held !== null && !DEPARTED_STATUSES.includes(String(held))) {
            sibling = await database('clubdesk_sync_proposals')
              .where({ member_id: p.member_id, field: 'register_status', status: 'pending' })
              .whereIn('proposed_value', DEPARTED_STATUSES)
              .first('id', 'proposed_value', 'rule')
            // No sibling means the status half was refused (or decided in an
            // older run): the two systems genuinely disagree about whether this
            // person left. Leave the date pending for a human rather than
            // forcing a departure nobody approved.
            if (!sibling) { skipped++; continue }
            patch.register_status = sibling.proposed_value
          }
        }
        await database('members').where('id', p.member_id).update(patch)
        await database('clubdesk_sync_proposals').where('id', p.id)
          .update({ status: 'accepted', ...stamp })
        await writeUserLog(database, log, {
          accountability: req.accountability, action: 'update',
          collection: 'members', recordId: p.member_id,
          data: { kind: 'clubdesk_proposal_accept', field: p.field, rule: p.rule, value: coerced.value },
        })
        applied++
        if (sibling) {
          await database('clubdesk_sync_proposals').where('id', sibling.id)
            .update({ status: 'accepted', ...stamp })
          await writeUserLog(database, log, {
            accountability: req.accountability, action: 'update',
            collection: 'members', recordId: p.member_id,
            data: {
              kind: 'clubdesk_proposal_accept', field: 'register_status', rule: sibling.rule,
              value: sibling.proposed_value, with_austritt: true,
            },
          })
          applied++
        }
      }

      return res.json({ decided: applied, skipped, flagged_for_push: flagged })
    } catch (err) {
      log.error({ msg: `clubdesk-sync/proposals/decide: ${err.message}`, endpoint: 'clubdesk-sync/proposals/decide', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Departed-in-ClubDesk detection (Data Health) ────────────────────────────
  // Members still active in wiedisync whose linked ClubDesk contact has a
  // non-active status (Kein Mitglied / Ehemaliges Mitglied / Verstorben) AND an
  // Austritt date — i.e. they left the club but linger here with rosters. The
  // Austritt guard excludes legit non-members with no exit date (volunteer
  // coaches marked "Kein Mitglied", or new signups whose contact isn't activated
  // yet) so they aren't false-flagged. Manual deactivate only. Superadmin.
  router.get('/clubdesk-departed', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const season = getCurrentSeason()
      const rows = await database
        .select('m.id as member_id', 'm.first_name', 'm.last_name', 'cd.status', 'cd.austritt')
        .from('members as m')
        .join('clubdesk_export as cd', database.raw('BTRIM(cd.clubdesk_id) = m.clubdesk_id'))
        .where('m.kscw_membership_active', true)
        .whereIn(database.raw('BTRIM(cd.status)'), DEPARTED_STATUSES)
        .whereRaw("NULLIF(BTRIM(cd.austritt), '') IS NOT NULL")
        .orderBy(['m.last_name', 'm.first_name'])
      const candidates = []
      for (const r of rows) {
        const teams = await database('member_teams as mt').join('teams as t', 't.id', 'mt.team')
          .where('mt.member', r.member_id).andWhere('t.active', true).distinct('t.name')
        candidates.push({
          member_id: r.member_id,
          member_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
          status: (r.status || '').trim(),
          austritt: (r.austritt || '').trim() || null,
          current_teams: teams.map((t) => t.name),
        })
      }
      return res.json({ candidates, season })
    } catch (err) {
      log.error({ msg: `clubdesk-departed: ${err.message}`, endpoint: 'clubdesk-departed', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Broken-link (stale) detection + resolution (Data Health) ────────────────
  // The mirror image of /clubdesk-departed. There the register says the person
  // LEFT; here the register no longer holds the contact AT ALL — the member's
  // clubdesk_id has no row in the last export, i.e. somebody deleted the contact
  // in ClubDesk.
  //
  // Until now that was DETECTED and nowhere actionable: computeMemberSyncStatuses
  // called it 'stale' and painted a red "Broken link" badge, and there the trail
  // ended. The member stayed active on every roster; /clubdesk-deactivate refused
  // them by construction (its predicate needs a LIVE contact row in a departed
  // status → 409 not_departed); the sync-up skipped them via the stale-link guard
  // (an unknown [Id] hard-aborts the whole ClubDesk import). A deleted contact was
  // a permanent read-only finding.
  //
  // ⚠⚠ `clubdesk_export` is TRUNCATEd and re-\copy'd on every sync-down, so an
  // empty or half-loaded snapshot makes EVERY linked member look stale. That is
  // survivable for a badge and NOT survivable for a list carrying a Deactivate
  // button on each row, so this check suppresses ITSELF rather than reporting a
  // club-wide false positive — and reports the suppression, because "no broken
  // links" and "the check refused to run" must never render identically.
  //
  // ⚠ The suppression is deliberately DATA-shaped, not state-shaped.
  // `clubdesk_member_sync.down_state` is a reliable BUSY signal but not a reliable
  // SUCCESS one: the weekly cron (Sat 22:00 UTC) runs clubdesk-sync.sh straight
  // from root's crontab and never touches the singleton, so a 'failed' left by an
  // old button press outlives any number of good cron runs — gating on it would
  // suppress this check forever on a club that syncs on the schedule.
  const STALE_SUPPRESS_FLOOR = 10
  const STALE_SUPPRESS_RATIO = 0.25

  /**
   * Linked + active members whose ClubDesk contact is gone from the snapshot.
   * Returns { candidates, suppressed, linked, export_rows, stale_count } where
   * `suppressed` is null or one of down_in_progress / export_empty /
   * export_incomplete — never an exception, so a bad snapshot degrades to
   * "cannot tell" instead of failing the whole Data Health run.
   */
  async function computeStaleLinks() {
    const empty = { candidates: [], linked: 0, export_rows: 0, stale_count: 0 }
    // A sync-down mid-flight is reloading the snapshot as
    // `BEGIN; TRUNCATE clubdesk_export; \copy …; COMMIT` — reads below would
    // block on that ACCESS EXCLUSIVE lock for the length of the run.
    const busy = await database('clubdesk_member_sync').where('id', 1).first('down_state')
    if (isBusy(busy?.down_state)) return { ...empty, suppressed: 'down_in_progress' }

    const linkedRows = await database('members')
      .where('kscw_membership_active', true)
      .where('clubdesk_sync_exclude', false)
      .whereRaw("NULLIF(BTRIM(clubdesk_id), '') IS NOT NULL")
      .select('id', 'first_name', 'last_name', 'clubdesk_id', 'clubdesk_pushed_at')
      .orderBy(['last_name', 'first_name'])
    const exportRows = Number((await database('clubdesk_export').count({ n: '*' }).first())?.n ?? 0)
    if (!exportRows) {
      return { ...empty, suppressed: 'export_empty', linked: linkedRows.length }
    }

    const present = new Set(
      (await database('clubdesk_export')
        .whereRaw("NULLIF(BTRIM(clubdesk_id), '') IS NOT NULL")
        .distinct(database.raw('BTRIM(clubdesk_id) AS cdid'))).map((r) => r.cdid),
    )
    const stale = linkedRows.filter((m) => !present.has(String(m.clubdesk_id).trim()))
    // Above this share of the linked cohort, "everybody is stale" describes a
    // broken snapshot, not a register full of deletions. The floor keeps a small
    // cohort (or a dev DB with a handful of links) from suppressing on 2 real ones.
    const cap = Math.max(STALE_SUPPRESS_FLOOR, Math.round(linkedRows.length * STALE_SUPPRESS_RATIO))
    if (stale.length > cap) {
      return {
        candidates: [], suppressed: 'export_incomplete',
        linked: linkedRows.length, export_rows: exportRows, stale_count: stale.length,
      }
    }

    const candidates = []
    for (const m of stale) {
      const teams = await database('member_teams as mt').join('teams as t', 't.id', 'mt.team')
        .where('mt.member', m.id).andWhere('t.active', true).distinct('t.name')
      candidates.push({
        member_id: m.id,
        member_name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
        clubdesk_id: String(m.clubdesk_id).trim(),
        pushed_at: m.clubdesk_pushed_at || null,
        current_teams: teams.map((t) => t.name),
      })
    }
    return {
      candidates, suppressed: null,
      linked: linkedRows.length, export_rows: exportRows, stale_count: stale.length,
    }
  }

  router.get('/clubdesk-stale', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      return res.json(await computeStaleLinks())
    } catch (err) {
      log.error({ msg: `clubdesk-stale: ${err.message}`, endpoint: 'clubdesk-stale', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  /**
   * The deactivation write itself, shared by the departed and broken-link flows.
   * ⚠ Drops rosters by MEMBERSHIP (every ACTIVE team), never by season string —
   * keying on the season left a departed member's roster row alive whenever the
   * stamp lagged, and every unseasoned reader still counted them as squad. See
   * the note on /clubdesk-deactivate.
   */
  async function deactivateMemberRow(req, memberId, kind) {
    const season = getCurrentSeason()
    const activeTeamIds = await database('teams').where('active', true).pluck('id')
    const dropped = activeTeamIds.length
      ? await database('member_teams').where('member', memberId).whereIn('team', activeTeamIds).del()
      : 0
    await database('members').where('id', memberId)
      .update({ kscw_membership_active: false, wiedisync_active: false })
    await writeUserLog(database, log, {
      accountability: req.accountability, action: 'update',
      collection: 'members', recordId: memberId,
      data: { kind, season, rosters_dropped: dropped },
    })
    return dropped
  }

  // Two decisions, because a vanished contact has two honest readings and the
  // server cannot tell them apart:
  //   unlink     — the contact was deleted in error (or merged into another one).
  //                The person is still ours: drop the dead id so they read as
  //                `not_linked` and the next sync-up can CREATE them afresh.
  //   deactivate — the deletion WAS the departure. Same write as
  //                /clubdesk-deactivate: not-a-member + active rosters dropped.
  //
  // ⚠ `unlink` MUST clear `clubdesk_pushed_at` as well. The up-preview's CREATE
  // list is `clubdesk_id IS NULL AND clubdesk_pushed_at IS NULL` — the latter
  // means "already pushed as new, awaiting its link back" — so a previously-pushed
  // member would unlink into a state that appears in NEITHER preview list, and go
  // invisible to both directions of the sync permanently.
  //
  // ⚠ `deactivate` KEEPS the dead clubdesk_id on purpose: it is the evidence of
  // which contact this was, and an inactive member drops out of every sync verdict
  // anyway (computeMemberSyncStatuses only looks at kscw_membership_active), so it
  // cannot come back as a finding.
  router.post('/clubdesk-stale/resolve', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const memberId = Number(req.body?.member_id)
      const action = String(req.body?.action || '')
      if (!Number.isInteger(memberId)) return res.status(400).json({ error: 'member_id required' })
      if (!['unlink', 'deactivate'].includes(action)) {
        return res.status(400).json({ error: "action must be 'unlink' or 'deactivate'", code: 'bad_action' })
      }
      const member = await database('members').where('id', memberId).first('id', 'clubdesk_id')
      if (!member) return res.status(404).json({ error: 'Member not found' })
      if (!String(member.clubdesk_id || '').trim()) {
        return res.status(409).json({ error: 'Member is not linked to a ClubDesk contact', code: 'not_linked' })
      }
      // Re-derive the finding server-side — snapshot guards included — rather than
      // trusting the list the caller clicked: a Data Health scan can be minutes
      // old, and a sync-down landing in between is precisely the case where the
      // link is no longer broken.
      const stale = await computeStaleLinks()
      if (stale.suppressed) {
        return res.status(409).json({
          error: 'The ClubDesk snapshot is not usable right now — run a sync down first',
          code: stale.suppressed,
        })
      }
      if (!stale.candidates.some((c) => c.member_id === memberId)) {
        return res.status(409).json({
          error: 'This ClubDesk link is no longer broken — refresh Data Health',
          code: 'not_stale',
        })
      }

      if (action === 'unlink') {
        await database('members').where('id', memberId)
          .update({ clubdesk_id: null, clubdesk_pushed_at: null })
        await writeUserLog(database, log, {
          accountability: req.accountability, action: 'update',
          collection: 'members', recordId: memberId,
          data: { kind: 'clubdesk_stale_unlink', clubdesk_id: String(member.clubdesk_id).trim() },
        })
        return res.json({ success: true, member_id: memberId, action })
      }

      const dropped = await deactivateMemberRow(req, memberId, 'clubdesk_stale_deactivate')
      return res.json({ success: true, member_id: memberId, action, rosters_dropped: dropped })
    } catch (err) {
      log.error({ msg: `clubdesk-stale/resolve: ${err.message}`, endpoint: 'clubdesk-stale/resolve', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── Per-member ClubDesk sync verdict (Data Explorer "ClubDesk sync" column) ──
  // Returns { statuses: { [member_id]: status } } with NO PII — one of:
  //   excluded   — clubdesk_sync_exclude (muted system account, out of scope)
  //   awaiting_link — pushed to ClubDesk as a new contact, not yet linked back
  //   not_linked — no clubdesk_id (never matched a ClubDesk contact)
  //   stale      — linked but the clubdesk_id has no live clubdesk_export row
  //   departed   — linked contact left the club (DEPARTED_STATUSES + Austritt)
  //   pending    — a sync-up push is queued (clubdesk_push_pending)
  //   drift      — linked + a field CONFLICT vs ClubDesk (reuses computeClubdeskDrift)
  //   in_sync    — linked, present, nothing queued, no conflicts
  // Fill-only members (wiedisync has data ClubDesk lacks) count as in_sync here —
  // those are benign one-way fills, not a mismatch (same reason Data Health
  // aggregates them away). Read-only; opened to admins + Vorstand + sport admins.
  /**
   * The per-member verdict itself, lifted out of its route so the merged
   * /admin/data-health page can list WHO needs syncing without re-deriving the
   * rule. Returns the member rows alongside the verdicts — callers that need
   * names/sport already have them and need not re-query.
   */
  async function computeMemberSyncStatuses() {
    const members = await database('members')
      .where('kscw_membership_active', true)
      .select('id', 'first_name', 'last_name', 'sektion', 'beitragskategorie',
        'clubdesk_id', 'clubdesk_push_pending', 'clubdesk_sync_exclude', 'clubdesk_pushed_at')
    // ClubDesk ids that actually exist in the register mirror → stale-link check.
    const exportIds = await database('clubdesk_export')
      .whereRaw("NULLIF(BTRIM(clubdesk_id), '') IS NOT NULL")
      .distinct(database.raw('BTRIM(clubdesk_id) AS cdid'))
    const present = new Set(exportIds.map((r) => r.cdid))
    // Departed (same query as /clubdesk-departed, ids only).
    const departedRows = await database
      .select('m.id AS member_id')
      .from('members as m')
      .join('clubdesk_export as cd', database.raw('BTRIM(cd.clubdesk_id) = m.clubdesk_id'))
      .where('m.kscw_membership_active', true)
      .whereIn(database.raw('BTRIM(cd.status)'), DEPARTED_STATUSES)
      .whereRaw("NULLIF(BTRIM(cd.austritt), '') IS NOT NULL")
    const departed = new Set(departedRows.map((r) => String(r.member_id)))
    // Real field conflicts (drift). Fill-only members are treated as in_sync.
    const drift = await computeClubdeskDrift()
    // ⚠ A name-only conflict is NOT the same finding and must not wear the same
    // badge (2026-08-15). Names can never be reconciled by syncing in either
    // direction: the push CSV is deliberately name-less (CD_PUSH_CONTACT_HEADERS
    // — an update row is [Id]-keyed so a push can never overwrite the register's
    // legal name) and the sync-down does not propose names either. So a member
    // whose only divergence is their name sat in "Needs syncing" labelled "a
    // field differs from ClubDesk" forever, implying an action that does not
    // exist — 15 of the 16 rows on prod were exactly this, and most of those are
    // OUR OWN doing (the export is CP1252, so Paweł→Pawel and Rachèle→Rachele on
    // the way out).
    //
    // They are given their own status rather than hidden: the same check is what
    // surfaces a genuine MIS-LINK. Member 163 "Aurora Cardinale Bosio" is bound
    // to contact 1001089 "Alberto Cascino" — same email, and carrying our own
    // pushed wiedisync_id — which reads as a name drift and is nothing of the
    // kind. Suppressing the category would have buried it.
    const NAME_FIELDS = new Set(['first_name', 'last_name'])
    const drifted = new Set(
      drift.filter((c) => c.conflicts.some((d) => !NAME_FIELDS.has(d.field)))
        .map((c) => String(c.member_id)),
    )
    const nameDrifted = new Set(
      drift.filter((c) => c.conflicts.length && c.conflicts.every((d) => NAME_FIELDS.has(d.field)))
        .map((c) => String(c.member_id)),
    )
    // The field-level diff, carried out so the list can say WHICH field differs
    // instead of "a field differs" (2026-08-16). It is the same data the
    // Club-wide findings already showed; the status list was throwing it away and
    // leaving the reader to go and look it up somewhere else.
    const conflictsById = new Map(
      drift.filter((c) => c.conflicts.length).map((c) => [String(c.member_id), c.conflicts]),
    )
    // The fields whose wiedisync side is EMPTY while ClubDesk holds a value.
    // /clubdesk-drift/flag refuses such a member outright (the push sends the
    // whole row, so it would blank the register), which made the worklist offer
    // a "flag ours" button that answered 409 on every click with no way to tell
    // why — Felix Stauch (405) sat like that with a real federation_of_origin
    // conflict and an empty phone. Carried per row so the list can say "sync
    // down first" INSTEAD of offering an action that cannot succeed.
    const blankRiskById = new Map(
      drift.filter((c) => c.blank_risk.length).map((c) => [String(c.member_id), c.blank_risk]),
    )

    const statuses = {}
    for (const m of members) {
      const id = String(m.id)
      let status
      if (m.clubdesk_sync_exclude === true) status = 'excluded'
      // ⚠ BEFORE not_linked, and it is not a nicety. Both states are "no
      // clubdesk_id", but only one of them is pushable: a member with a
      // clubdesk_pushed_at was already created in ClubDesk and is waiting for
      // the next sync-down to read its [Id] back — offering it again would
      // DUPLICATE the contact, which is why the CREATE set excludes it. Calling
      // that `not_linked` made the worklist say "create them with a sync up"
      // about a contact that already exists, and stalled the sync path on a
      // step whose modal was empty.
      else if (!m.clubdesk_id && m.clubdesk_pushed_at) status = 'awaiting_link'
      else if (!m.clubdesk_id) status = 'not_linked'
      else if (!present.has(String(m.clubdesk_id).trim())) status = 'stale'
      else if (departed.has(id)) status = 'departed'
      else if (m.clubdesk_push_pending === true) status = 'pending'
      else if (drifted.has(id)) status = 'drift'
      else if (nameDrifted.has(id)) status = 'name_drift'
      else status = 'in_sync'
      statuses[id] = status
    }
    return { statuses, members, conflictsById, blankRiskById }
  }

  router.get('/clubdesk-sync-status', async (req, res) => {
    try {
      if (!(await syncStatusGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const { statuses } = await computeMemberSyncStatuses()
      return res.json({ statuses })
    } catch (err) {
      log.error({ msg: `clubdesk-sync-status: ${err.message}`, endpoint: 'clubdesk-sync-status', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── "Who still needs syncing" — the same verdicts, as an actionable list ─────
  // /clubdesk-sync-status answers "what is member X's state" for a grid that
  // already holds the members. This answers the merged Data Health question
  // instead: since the last sync down/up, WHO is out of step — with the name,
  // the section (so the sport tabs can bucket them) and the last invoice, so the
  // operator never has to leave the page to tell a lapsed member from a live one.
  //
  // `in_sync` and `excluded` are omitted: this is a worklist, not a census. The
  // counts of both are returned so "0 rows" reads as "everyone is in step"
  // rather than "the check stopped looking".
  // `name_drift` is listed so the finding stays VISIBLE (it is how a mis-link
  // surfaces) — the frontend labels it honestly as "cannot be synced" instead of
  // offering an action that does not exist.
  // ⚠ `drift` is deliberately ABSENT (migration 338). A value disagreement is a
  // decision, and decisions live in clubdesk_sync_proposals as `conflict` rows —
  // where refusing is durable. Listing it here too gave one disagreement two
  // homes and two verbs ("Refuse" and "Keep ours" both flag for push), and the
  // board's copy was the one that could not remember the answer.
  // ⚠ `name_drift` STAYS: no sync in either direction can reconcile a name, so
  // it is a standing state rather than a pending decision — and it is the only
  // place a mis-linked contact surfaces.
  // ⓘ computeMemberSyncStatuses still RETURNS `drift`; the Data Explorer's
  // per-member column reads it and would otherwise report a member with an open
  // conflict as "In sync".
  const NEEDS_SYNC_STATUSES = ['not_linked', 'awaiting_link', 'stale', 'departed', 'pending', 'name_drift']
  router.get('/clubdesk-needs-sync', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const { statuses, members, conflictsById, blankRiskById } = await computeMemberSyncStatuses()
      const rows = members.filter((m) => NEEDS_SYNC_STATUSES.includes(statuses[String(m.id)]))

      // Section per member, from the ONE server-side resolver. The detailed form
      // is what lets the UI separate a genuinely dual-sport member from one whose
      // section simply cannot be derived — they share the answer 'both'.
      const sportById = await resolveMemberSportsDetailed(
        database, rows.map((m) => m.id), { memberRows: rows })
      const bills = await lastBillsByMember(rows.map((m) => m.id))

      const sync = await database('clubdesk_member_sync').where('id', 1)
        .first('down_last_success_at', 'up_finished_at')

      // How many members a sync-up would actually carry, from the SAME predicate
      // the up-preview lists — never re-derived from the statuses above. The
      // worklist and the push set answer different questions and disagree on
      // exactly the rows that matter: `awaiting_link` is listed here (the
      // operator should see it) and is deliberately unpushable.
      const [upd, cre] = await Promise.all([
        pushableUpdates().count({ n: '*' }).first(),
        pushableCreates().count({ n: '*' }).first(),
      ])

      return res.json({
        rows: rows.map((m) => {
          const s = sportById.get(String(m.id)) || { sport: 'both', source: 'unknown' }
          return {
            member_id: m.id,
            member_name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
            clubdesk_id: m.clubdesk_id || '',
            status: statuses[String(m.id)],
            sport: s.sport,
            // 'unknown' ⇒ the Unassigned tab. Never fold this into `sport` —
            // 'both' would then claim the member plays two sports.
            sport_source: s.source,
            last_bill: bills.get(String(m.id)) || null,
            // [{ field, wiedisync, clubdesk }] — empty for the statuses that are
            // not a field disagreement (not_linked / stale / departed / pending).
            conflicts: conflictsById.get(String(m.id)) || [],
            // Field names the push would blank → /clubdesk-drift/flag will refuse
            // this member. Non-empty means the row's fix is "sync down", not "flag".
            blank_risk: blankRiskById.get(String(m.id)) || [],
          }
        }),
        // ⚠ The sync-path runner gates step 3 on this. It counts what the push
        // CARRIES, which is not the same as the rows listed above.
        pending_push: Number(upd?.n || 0) + Number(cre?.n || 0),
        in_sync: Object.values(statuses).filter((s) => s === 'in_sync').length,
        excluded: Object.values(statuses).filter((s) => s === 'excluded').length,
        // ⚠ The last SUCCESSFUL down, never merely the last finished one.
        last_down: sync?.down_last_success_at || null,
        last_up: sync?.up_finished_at || null,
      })
    } catch (err) {
      log.error({ msg: `clubdesk-needs-sync: ${err.message}`, endpoint: 'clubdesk-needs-sync', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  /**
   * Most recent invoice per member, across EVERY source.
   *
   * ⚠ Deliberately not filtered to `source='clubdesk'`. Dues are mid-migration off
   * ClubDesk onto native wiedisync invoices, so a source filter would report a
   * freshly-billed member as "never billed" the moment their invoice was issued
   * here instead of there — the exact failure the column exists to catch.
   *
   * `open_amount` rides along because "billed" and "paid" are different questions
   * and the operator is usually asking the second one.
   */
  async function lastBillsByMember(memberIds) {
    const ids = [...new Set((memberIds || []).filter((v) => v !== null && v !== undefined))]
    const out = new Map()
    if (!ids.length) return out
    // DISTINCT ON keeps this one index-friendly pass rather than a per-member
    // subquery over ~2.7k invoices.
    const rows = await database
      .select('member', 'invoice_date', 'status', 'amount', 'open_amount', 'source', 'number')
      .from(database.raw(
        `(SELECT DISTINCT ON (member) member, invoice_date, status, amount, open_amount, source, number
            FROM finance_invoices
           WHERE member = ANY(?) AND cancelled_at IS NULL
           ORDER BY member, invoice_date DESC NULLS LAST, id DESC) AS li`, [ids]))
    for (const r of rows) {
      out.set(String(r.member), {
        date: r.invoice_date || null,
        status: r.status || null,
        amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
        open: r.open_amount === null || r.open_amount === undefined ? null : Number(r.open_amount),
        source: r.source || null,
        number: r.number || null,
      })
    }
    return out
  }

  // ── Per-member facets the merged Data Health page joins into every table ────
  // The findings themselves arrive from several endpoints, each keyed by member.
  // Rather than teach all of them about sections and invoices, this returns the
  // two cross-cutting facets ONCE for the whole active club (~700 rows, small
  // payload) and the page joins them client-side:
  //   sports — which tab a member belongs under. `source: 'unknown'` is the
  //            Unassigned tab; folding it into `sport` would make it 'both',
  //            i.e. a claim the member plays two sports.
  //   bills  — most recent invoice, so "billed as a player but on no roster"
  //            can be judged without leaving the page.
  // Superadmin: an invoice amount is finance data and this is not own-row scoped.
  router.get('/clubdesk-member-facets', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const rows = await database('members').where('kscw_membership_active', true)
        .select('id', 'sektion', 'beitragskategorie')
      const ids = rows.map((m) => m.id)
      const [bills, sports] = await Promise.all([
        lastBillsByMember(ids),
        resolveMemberSportsDetailed(database, ids, { memberRows: rows }),
      ])
      return res.json({
        bills: Object.fromEntries(bills),
        sports: Object.fromEntries(sports),
      })
    } catch (err) {
      log.error({ msg: `clubdesk-member-facets: ${err.message}`, endpoint: 'clubdesk-member-facets', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  /** '2026/27' → '2025/26'. Used to tell a "lapsed" player (rostered last
   *  season, not this one) apart from one who was never rostered at all. */
  function prevSeason(s) {
    const m = String(s || '').match(/^(\d{4})\/(\d{2})$/)
    if (!m) return null
    const start = Number(m[1]) - 1
    return `${start}/${String((start + 1) % 100).padStart(2, '0')}`
  }

  // ── ClubDesk consistency checks (sync page + Data Health) ───────────────────
  // ClubDesk group membership can only be set by hand in ClubDesk (the CSV import
  // treats Gruppen as a no-op), so it silently drifts from the Wiedisync rosters.
  // Read-only checks — the fix is always made in ClubDesk / on the roster:
  //   • missing — a current-season player whose team's CD group token is not in
  //     their gruppen_bracketed → assign it in ClubDesk. A core player expects
  //     '<group> (Spieler*in)'; a guest (guest_level > 0) expects '<group>
  //     (Guest)' instead — same team, different ClubDesk Funktion (VB and BB).
  //   • stale_funktion — the exact inverse of `missing`, and the blind spot that
  //     hid 29 contacts until 2026-07-30: the member holds the WRONG Funktion for
  //     a team they are still on ('<group> (Spieler*in)' while wiedisync says
  //     guest, or vice versa). `missing` can't see it (it only reports an ABSENT
  //     expected token) and `strays` can't either (it requires ZERO current-season
  //     roster rows, which excludes every guest by construction) — so a player
  //     flipped to guest accumulated both allocations forever. Both assignment
  //     paths are add-only (ClubDesk's "Kontakt zu Gruppe hinzufügen", mirrored by
  //     clubdesk-scrape-groups.mjs), so nothing ever retired the old one.
  //     Removal worklist for clubdesk-remove-group.mjs: `uuid` + `group`.
  //   • no_group — a linked member whose CD contact carries NO group token at all.
  //     Invisible to `missing`, which only inspects members who are ON a team.
  //   • coach_no_group — coaches (teams_coaches) missing their team's
  //     '<group> (Trainer*in)' token. NB there is no ClubDesk role token for
  //     team-responsible, so TRs are deliberately not checked.
  //   • fee_no_roster — pays a PLAYING Beitragskategorie but is on no
  //     current-season roster: billed as a player while on no team. Bucketed by
  //     severity (never rostered / played last season / older) so the list is
  //     triageable rather than a 165-row dump.
  //   • strays — someone in a CD player-group with ZERO current-season Wiedisync
  //     presence (that filter drops umbrella-BB + guests, who do have a row)
  //     whose group maps to a real team → left the team (remove) or missing from
  //     the roster (add). Annotated with active / official-licence / coach-of so
  //     an admin can tell the two apart without leaving the page.
  //   • no_team_groups — CD player-groups with no matching Wiedisync team at all
  //     (e.g. a renamed/merged team like VB DU19) → structural, one row each.
  //   • unmapped_teams — an ACTIVE team whose clubdesk_group is still NULL, i.e.
  //     nobody has said which CD group it maps to. Such a team is invisible to
  //     every check above, so it must be flagged rather than silently skipped.
  // Superadmin-gated, read-only.
  /**
   * The group-consistency computation itself, lifted out of its route (2026-08-13)
   * so the on-demand "Fix groups" job builds its worklist from THE SAME rows the
   * operator just approved on screen.
   *
   * ⚠ Never re-derive these predicates anywhere else. Two copies of a scope rule
   * is how one of them quietly stops matching the other (see member-sport.js) —
   * and here the divergent copy would be the one writing to the club's LEGAL
   * member register. `clubdesk-group-cleanup.sh` already carries a hand-mirrored
   * copy of straySql/staleFunktionSql for the unattended Sunday run; that one is
   * documented as a mirror and capped. Nothing else may fork them.
   */
  async function computeGroupChecks() {
  // Needed by the `fee_no_roster` severity badge (`prevSeason(season)`) and
  // echoed in the response. Its absence 500'd this whole endpoint.
  const season = getCurrentSeason()

  // team → ClubDesk group token, now read from teams.clubdesk_group
  // (migration 205) instead of a hardcoded CASE. Three-state by design:
  //   NULL → not configured → surfaced in `unmapped_teams` (never skipped)
  //   ''   → intentionally no CD group (league umbrellas) → excluded
  //   else → the exact CD group token.
  // Only the '' rows are excluded here; NULL rows are excluded from the group
  // maths too but get reported, which is the whole point of the column.
  // ⚠ t.active: this CTE feeds `strays`, which is the operator's work list
  // for STRIPPING people from a group in the club's legal register — the one
  // output here that drives a destructive proposal. Without it an archived
  // team's roster competes with the live one and a season-lagged player is
  // both invisible to `missing` and present in `strays`.
  const teamGroupCte = `
    tg AS (
      SELECT t.id, NULLIF(t.clubdesk_group, '') AS clubdesk_group, t.sport
      FROM teams t
      WHERE t.clubdesk_group IS NOT NULL AND t.active
    )`

  // Non-playing fee categories: these legitimately have no roster row.
  // Anything else is a "playing" fee — being billed to play.
  const NON_PLAYING_KAT = ['Passivmitglied', 'Gratis', 'Kein Beitrag']

  // Guests (guest_level > 0) are expected in the team's '<group> (Guest)'
  // subgroup, core players in '<group> (Spieler*in)' — one row per
  // member_teams entry, so someone who is a guest on team A and core on
  // team B is checked for both tokens independently.
  // `uuid` + the bare Funktion ride along because this list IS the ADD worklist for
  // clubdesk-scrape-groups.mjs: it filters the ClubDesk grid by the Wiedisync uuid
  // (unique, accent- and drift-proof — the clubdesk_id is NOT grid-searchable) and
  // picks Gruppe + Funktion as two separate combos, so the bracketed token has to
  // come apart again. See CLAUDE.md → ClubDesk contact matching in the UI.
  const missingSql = `
    WITH ${teamGroupCte}, expected AS (
      SELECT m.id AS member_id, m.first_name, m.last_name, m.clubdesk_id, m.uuid, tg.sport,
             tg.clubdesk_group AS grp_base,
             CASE WHEN COALESCE(mt.guest_level, 0) > 0
                  THEN '${CD_GUEST_FUNKTION}' ELSE 'Spieler*in' END AS funktion,
             (tg.clubdesk_group || CASE WHEN COALESCE(mt.guest_level, 0) > 0
                                        THEN ' (${CD_GUEST_FUNKTION})' ELSE ' (Spieler*in)' END) AS grp
      FROM member_teams mt
      JOIN tg ON tg.id = mt.team
      JOIN members m ON m.id = mt.member
      -- No mt.season predicate: tg is active-teams-only, and a teams row
      -- belongs to exactly one season, so the join already pins it.
      WHERE tg.clubdesk_group IS NOT NULL AND m.clubdesk_id IS NOT NULL
    )
    SELECT e.member_id, e.first_name, e.last_name, e.clubdesk_id, e.uuid, e.grp, e.grp_base,
           e.funktion, e.sport,
           NULLIF(BTRIM(COALESCE(ce.vorname, '')), '') AS cd_vorname,
           NULLIF(BTRIM(COALESCE(ce.nachname, '')), '') AS cd_nachname
    FROM expected e
    LEFT JOIN clubdesk_export ce ON BTRIM(ce.clubdesk_id) = e.clubdesk_id
    WHERE NOT (e.grp = ANY(string_to_array(COALESCE(ce.gruppen_bracketed, ''), ', ')))
    ORDER BY e.last_name, e.first_name, e.grp`

  // stale_funktion — the member IS on the team, but their ClubDesk contact
  // carries the OTHER Funktion for that same group. Same `expected` CTE shape
  // as `missing`, only the predicate flips: there we assert the wanted token
  // is absent, here we assert the unwanted one is present. `has_correct` says
  // whether the right token sits alongside it (the usual case — then this is a
  // pure removal; when false the member is ALSO in `missing`, i.e. one swap).
  // `uuid` is carried because clubdesk-remove-group.mjs filters ClubDesk by
  // the wiedisync uuid, never by name (name drift is real — "Berke-Wenger").
  // The name is taken from the REGISTER (ce.vorname/ce.nachname) so the
  // operator reads the row as ClubDesk spells it; wiedisync's is the fallback.
  const staleFunktionSql = `
    WITH ${teamGroupCte}, expected AS (
      SELECT m.id AS member_id, m.first_name, m.last_name, m.clubdesk_id, m.uuid, tg.sport,
             COALESCE(mt.guest_level, 0) > 0 AS is_guest,
             (tg.clubdesk_group || CASE WHEN COALESCE(mt.guest_level, 0) > 0
                                        THEN ' (${CD_GUEST_FUNKTION})' ELSE ' (Spieler*in)' END) AS want_grp,
             (tg.clubdesk_group || CASE WHEN COALESCE(mt.guest_level, 0) > 0
                                        THEN ' (Spieler*in)' ELSE ' (${CD_GUEST_FUNKTION})' END) AS stale_grp
      FROM member_teams mt
      JOIN tg ON tg.id = mt.team
      JOIN members m ON m.id = mt.member
      -- No mt.season predicate: tg is active-teams-only, and a teams row
      -- belongs to exactly one season, so the join already pins it.
      WHERE tg.clubdesk_group IS NOT NULL AND m.clubdesk_id IS NOT NULL
    )
    SELECT e.member_id, e.first_name, e.last_name, e.clubdesk_id, e.uuid, e.sport,
           e.is_guest, e.stale_grp, e.want_grp,
           NULLIF(BTRIM(COALESCE(ce.vorname, '')), '') AS cd_vorname,
           NULLIF(BTRIM(COALESCE(ce.nachname, '')), '') AS cd_nachname,
           (e.want_grp = ANY(string_to_array(COALESCE(ce.gruppen_bracketed, ''), ', '))) AS has_correct
    FROM expected e
    JOIN clubdesk_export ce ON BTRIM(ce.clubdesk_id) = e.clubdesk_id
    WHERE e.stale_grp = ANY(string_to_array(COALESCE(ce.gruppen_bracketed, ''), ', '))
    ORDER BY e.last_name, e.first_name, e.stale_grp`

  const straySql = `
    WITH ${teamGroupCte}, cd_groups AS (
      SELECT BTRIM(ce.clubdesk_id) AS clubdesk_id, BTRIM(g) AS grp
      FROM clubdesk_export ce, LATERAL unnest(string_to_array(ce.gruppen_bracketed, ', ')) AS g
      WHERE g LIKE '%(Spieler*in)%'
    ),
    team_groups AS (
      -- team_ids is what makes the stray test PER GROUP (2026-08-15). Several
      -- active teams may share one clubdesk_group, so it is an array, not an id.
      SELECT (clubdesk_group || ' (Spieler*in)') AS grp, string_agg(DISTINCT sport, ', ') AS sports,
             array_agg(id) AS team_ids
      FROM tg WHERE clubdesk_group IS NOT NULL
      GROUP BY clubdesk_group
    )
    SELECT cg.grp, tgr.sports, m.id AS member_id, m.first_name, m.last_name, cg.clubdesk_id,
           m.uuid,
           -- Inside the auto-remove envelope the Sunday cleanup cron already acts on
           -- (clubdesk-group-cleanup.sh): the member HAS LEFT the club, or still
           -- belongs but staffs a team rather than playing on one ("the Lasse
           -- pattern"). Everything else is AMBIGUOUS — usually a missing wiedisync
           -- roster row, not a wrong ClubDesk group — and must stay a human call.
           -- ⚠ "Left" is a MEMBERSHIP fact only. Keying it on wiedisync_active (i.e.
           -- "never activated a login", true for ~500 of 709 members) is what wiped
           -- 29 DU20 girls out of ClubDesk on 2026-07-16.
           (
             EXISTS (SELECT 1 FROM clubdesk_export ce2
                      WHERE BTRIM(ce2.clubdesk_id) = m.clubdesk_id
                        AND (ce2.status IN ('Kein Mitglied', 'Ehemaliges Mitglied', 'Verstorben')
                             OR COALESCE(BTRIM(ce2.austritt), '') <> ''))
             OR m.kscw_membership_active = false
             -- ⚠ Scoped to THIS group's teams (2026-08-15). "Staffs a team rather
             -- than playing on one" only licenses removing the token for the team
             -- they staff; coaching HU20 is no reason to strip a stale D2 player
             -- token. Unscoped it was survivable only because the stray test
             -- required a member with no roster ANYWHERE; per-group it would hand
             -- every player-coach's tokens to the auto-remover.
             OR EXISTS (SELECT 1 FROM teams_coaches tc WHERE tc.members_id = m.id AND tc.teams_id = ANY(tgr.team_ids))
             OR EXISTS (SELECT 1 FROM teams_responsibles tr WHERE tr.members_id = m.id AND tr.teams_id = ANY(tgr.team_ids))
           ) AS auto_removable,
           COALESCE(m.wiedisync_active, false) AS active,
           (COALESCE(m.referee_vb,false) OR COALESCE(m.scorer_vb,false) OR COALESCE(m.referee_bb,false)
            OR COALESCE(m.otr1_bb,false) OR COALESCE(m.otr2_bb,false)
            OR COALESCE(m.otn1_bb,false) OR COALESCE(m.otn2_bb,false)) AS is_official,
           COALESCE((SELECT string_agg(DISTINCT t2.name, ', ') FROM teams_coaches tc JOIN teams t2 ON t2.id = tc.teams_id WHERE tc.members_id = m.id), '') AS coach_of,
           COALESCE((SELECT string_agg(DISTINCT t3.name, ', ') FROM teams_responsibles tr JOIN teams t3 ON t3.id = tr.teams_id WHERE tr.members_id = m.id), '') AS tr_of
    FROM cd_groups cg
    JOIN team_groups tgr ON tgr.grp = cg.grp
    JOIN members m ON m.clubdesk_id = cg.clubdesk_id
    -- ⚠⚠ PER GROUP, not per member (2026-08-15). This used to ask "does this
    -- member sit on ANY active roster?", which meant a player token for a team
    -- they only COACH was invisible for anyone who plays somewhere else — the
    -- exact case that let a wrong 'VB HU23 (Spieler*in)' sit on a member whose
    -- only HU23 role is coaching, while he legitimately plays H3. A token for
    -- team X is stray when there is no active roster row for team X, full stop.
    -- On prod this moved the finding count 3 → 20, and 17 of the 20 are human
    -- calls rather than auto-removals, which is the point: most are stale tokens
    -- left by a team change, not junk to delete.
    WHERE NOT EXISTS (
      SELECT 1 FROM member_teams mt
      WHERE mt.member = m.id AND mt.team = ANY(tgr.team_ids))
    ORDER BY cg.grp, m.last_name, m.first_name`

  const noTeamSql = `
    WITH ${teamGroupCte}
    SELECT BTRIM(g) AS grp, COUNT(DISTINCT BTRIM(ce.clubdesk_id))::int AS cnt
    FROM clubdesk_export ce, LATERAL unnest(string_to_array(ce.gruppen_bracketed, ', ')) AS g
    WHERE g LIKE '%(Spieler*in)%'
      AND BTRIM(g) NOT IN (SELECT DISTINCT (clubdesk_group || ' (Spieler*in)') FROM tg WHERE clubdesk_group IS NOT NULL)
    GROUP BY BTRIM(g)
    ORDER BY cnt DESC, grp`

  // no_group — linked members whose ClubDesk contact carries NO group token at
  // all. Invisible to `missing`, which only inspects members who are ON a
  // Wiedisync team: someone with no team AND no ClubDesk group is flagged by
  // nothing else today. `teams` is annotated so the admin knows which group to
  // assign — a no-group member WITH a team is the urgent case (they play, yet
  // the register has them in nothing). Muted (sync-excluded) accounts skipped.
  const noGroupSql = `
    WITH cd AS (
      SELECT DISTINCT ON (BTRIM(clubdesk_id)) BTRIM(clubdesk_id) AS cdid, gruppen_bracketed
      FROM clubdesk_export
      WHERE NULLIF(BTRIM(clubdesk_id), '') IS NOT NULL
      ORDER BY BTRIM(clubdesk_id), row_id
    )
    SELECT m.id AS member_id, m.first_name, m.last_name, m.clubdesk_id,
           COALESCE(NULLIF(BTRIM(m.beitragskategorie), ''), '') AS kat,
           COALESCE((
             SELECT string_agg(DISTINCT t.name, ', ')
             FROM member_teams mt JOIN teams t ON t.id = mt.team
             WHERE mt.member = m.id AND t.active AND COALESCE(mt.guest_level, 0) = 0
           ), '') AS teams,
           COALESCE((
             SELECT string_agg(DISTINCT t.sport, ', ')
             FROM member_teams mt JOIN teams t ON t.id = mt.team
             WHERE mt.member = m.id AND t.active AND COALESCE(mt.guest_level, 0) = 0
           ), '') AS sports
    FROM members m
    JOIN cd ON cd.cdid = m.clubdesk_id
    WHERE m.kscw_membership_active
      AND COALESCE(m.clubdesk_sync_exclude, false) = false
      AND NULLIF(BTRIM(COALESCE(cd.gruppen_bracketed, '')), '') IS NULL
    ORDER BY m.last_name, m.first_name`

  // coach_no_group — a coach (teams_coaches) whose CD contact lacks the
  // '<group> (Trainer*in)' token for a team they actually coach. 'Trainer*in'
  // is the only coaching role token ClubDesk carries (there is no
  // team-responsible equivalent), so TRs are out of scope by design.
  const coachNoGroupSql = `
    WITH ${teamGroupCte}, expected AS (
      SELECT m.id AS member_id, m.first_name, m.last_name, m.clubdesk_id, m.uuid, tg.sport,
             tg.clubdesk_group AS grp_base, 'Trainer*in' AS funktion,
             (tg.clubdesk_group || ' (Trainer*in)') AS grp
      FROM teams_coaches tc
      JOIN tg ON tg.id = tc.teams_id
      JOIN teams t ON t.id = tc.teams_id
      JOIN members m ON m.id = tc.members_id
      WHERE tg.clubdesk_group IS NOT NULL AND m.clubdesk_id IS NOT NULL
        AND t.active AND m.kscw_membership_active
        AND COALESCE(m.clubdesk_sync_exclude, false) = false
    )
    SELECT e.member_id, e.first_name, e.last_name, e.clubdesk_id, e.uuid, e.grp, e.grp_base,
           e.funktion, e.sport,
           NULLIF(BTRIM(COALESCE(ce.vorname, '')), '') AS cd_vorname,
           NULLIF(BTRIM(COALESCE(ce.nachname, '')), '') AS cd_nachname
    FROM expected e
    LEFT JOIN clubdesk_export ce ON BTRIM(ce.clubdesk_id) = e.clubdesk_id
    WHERE NOT (e.grp = ANY(string_to_array(COALESCE(ce.gruppen_bracketed, ''), ', ')))
    ORDER BY e.last_name, e.first_name, e.grp`

  // fee_no_roster — pays a PLAYING Beitragskategorie but sits on no
  // current-season roster (guest rows don't count). Severity is derived from
  // roster history so the admin can triage instead of facing one flat list:
  //   never   — never on ANY roster (strongest signal)
  //   lapsed  — was on last season's roster, not this one (left / not yet assigned)
  //   older   — only has roster rows from an earlier season
  // Coach/TR duties are annotated: a non-playing coach on a playing fee is a
  // judgement call, not automatically an error.
  const feeNoRosterSql = `
    SELECT m.id AS member_id, m.first_name, m.last_name, m.clubdesk_id,
           BTRIM(COALESCE(m.beitragskategorie, '')) AS kat,
           (SELECT MAX(mt.season) FROM member_teams mt
             WHERE mt.member = m.id AND COALESCE(mt.guest_level, 0) = 0) AS last_season,
           COALESCE((SELECT string_agg(DISTINCT t2.name, ', ') FROM teams_coaches tc
                      JOIN teams t2 ON t2.id = tc.teams_id WHERE tc.members_id = m.id), '') AS coach_of,
           COALESCE((SELECT string_agg(DISTINCT t3.name, ', ') FROM teams_responsibles tr
                      JOIN teams t3 ON t3.id = tr.teams_id WHERE tr.members_id = m.id), '') AS tr_of
    FROM members m
    WHERE m.kscw_membership_active
      AND COALESCE(m.clubdesk_sync_exclude, false) = false
      AND BTRIM(COALESCE(m.beitragskategorie, '')) <> ''
      AND BTRIM(COALESCE(m.beitragskategorie, '')) <> ALL (:nonPlaying)
      AND NOT EXISTS (
        SELECT 1 FROM member_teams mt JOIN teams t2 ON t2.id = mt.team
        WHERE mt.member = m.id AND t2.active AND COALESCE(mt.guest_level, 0) = 0
      )
    ORDER BY m.last_name, m.first_name`

  // unmapped_teams — active teams with no ClubDesk group configured at all
  // (clubdesk_group IS NULL). They are invisible to every group check, so a
  // new/renamed team can never silently drop out of coverage.
  // ⚠ An EMPTY STRING is unmapped too (2026-08-15). `IS NULL` alone reported 0
  // while two active basketball teams — H-Classics 1LR and Damen D-Classics 1LR —
  // carried `clubdesk_group = ''`, so the guard that exists to say "every check
  // below is incomplete" stayed silent about the very teams whose players were
  // then flagged as strays for their OLD team's token. `tg` already uses
  // NULLIF(clubdesk_group,''), so the two disagreed about what "mapped" means.
  const unmappedTeamsSql = `
    SELECT t.id, t.name, t.sport
    FROM teams t
    WHERE t.active AND NULLIF(BTRIM(t.clubdesk_group), '') IS NULL
    ORDER BY t.sport, t.name`

  // ── Honorary drift ──────────────────────────────────────────────────
  // "Ehrenmitglied" is TWO facts in ClubDesk and they disagree: the
  // Ehrenmitglieder GROUP is the honour (and the club's chosen truth — see
  // MAILBOX_GROUPS), while the single-valued register Status doubles as the
  // billing axis and therefore records an honorary member who still plays
  // as 'Aktivmitglied'. Measured on prod 2026-08-10: 15 in the group, 12 by
  // status, 10 both.
  //
  // Only the two ASYMMETRIC cases are reported, because only they are
  // actionable:
  //   status_only — the status says Ehrenmitglied but the group does not
  //                 hold them, so the honour list (and every mailing built
  //                 on it) is missing somebody.
  //   fee         — in the group but NOT paying 'Gratis', i.e. an honorary
  //                 member still being billed.
  // The reverse (in the group, status 'Aktivmitglied') is the EXPECTED
  // shape for a playing Ehrenmitglied and is deliberately NOT flagged —
  // flagging it would report five correct rows forever.
  const honoraryDriftSql = `
    WITH cd AS (
      SELECT DISTINCT ON (btrim(clubdesk_id)) btrim(clubdesk_id) AS cid, gruppen_bracketed
        FROM clubdesk_export
       WHERE NULLIF(btrim(clubdesk_id), '') IS NOT NULL
       ORDER BY btrim(clubdesk_id), row_id
    )
    SELECT m.id AS member_id, m.first_name, m.last_name, m.clubdesk_id,
           m.register_status, m.beitragskategorie,
           -- An explicit CHF 0 base override is a waiver the treasurer
           -- entered by hand (migration 299) and, unlike the category, one
           -- ClubDesk cannot overwrite. Without this the check would report
           -- "still billed" forever for somebody who is not: the category
           -- reverts to the register's on every sync-down, the override
           -- does not.
           (m.fee_base_override IS NOT NULL AND m.fee_base_override = 0) AS fee_waived,
           EXISTS (
             SELECT 1 FROM unnest(string_to_array(cd.gruppen_bracketed, ',')) g
              WHERE btrim(g) = 'Ehrenmitglieder'
           ) AS in_group
      FROM members m
      JOIN cd ON cd.cid = m.clubdesk_id
     WHERE m.kscw_membership_active = true
       AND (
         (m.register_status = 'Ehrenmitglied' AND NOT EXISTS (
           SELECT 1 FROM unnest(string_to_array(cd.gruppen_bracketed, ',')) g
            WHERE btrim(g) = 'Ehrenmitglieder'))
         OR (EXISTS (
           SELECT 1 FROM unnest(string_to_array(cd.gruppen_bracketed, ',')) g
            WHERE btrim(g) = 'Ehrenmitglieder')
           AND COALESCE(NULLIF(btrim(m.beitragskategorie), ''), '') <> 'Gratis')
       )
     ORDER BY m.last_name, m.first_name`

  const [missingRes, strayRes, noTeamRes, noGroupRes, coachRes, feeRes, unmappedRes, staleRes, honoraryRes] = await Promise.all([
    database.raw(missingSql),
    database.raw(straySql),
    database.raw(noTeamSql),
    database.raw(noGroupSql),
    database.raw(coachNoGroupSql),
    database.raw(feeNoRosterSql, { nonPlaying: NON_PLAYING_KAT }),
    database.raw(unmappedTeamsSql),
    database.raw(staleFunktionSql),
    database.raw(honoraryDriftSql),
  ])

  // Playing Beitragskategorien are 'VB '/'BB '-prefixed — the only sport
  // signal for members with no roster row.
  const katSport = (kat) => (kat || '').startsWith('VB ') ? 'volleyball'
    : (kat || '').startsWith('BB ') ? 'basketball' : ''

  // `missing` and `coach_no_group` share this shape. `groups` stays the display
  // list; `allocations` is the machine-readable half the ADD worklist is built
  // from — one entry per (Gruppe, Funktion) pair, because clubdesk-scrape-groups.mjs
  // fills those as two separate combos rather than one bracketed token.
  const foldByMember = (rows) => {
    const byMember = new Map()
    for (const r of rows) {
      if (!byMember.has(r.member_id)) {
        byMember.set(r.member_id, {
          member_id: r.member_id,
          member_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
          // ClubDesk's grid renders "Nachname Vorname"; carry its own spelling so
          // an operator reading the preview sees the row as ClubDesk shows it.
          clubdesk_name: [r.cd_nachname || r.last_name, r.cd_vorname || r.first_name].filter(Boolean).join(' '),
          clubdesk_id: r.clubdesk_id,
          uuid: r.uuid || '',
          groups: [],
          allocations: [],
          sports: new Set(),
        })
      }
      const c = byMember.get(r.member_id)
      c.groups.push(r.grp)
      c.allocations.push({ group: r.grp_base, funktion: r.funktion, label: r.grp })
      if (r.sport) c.sports.add(r.sport)
    }
    return byMember
  }

  const coachByMember = foldByMember(coachRes.rows)

  const fee_no_roster = feeRes.rows.map((r) => ({
    member_id: r.member_id,
    member_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    clubdesk_id: r.clubdesk_id,
    kat: r.kat || '',
    sport: katSport(r.kat),
    last_season: r.last_season || null,
    coach_of: r.coach_of || '',
    tr_of: r.tr_of || '',
    // never > lapsed > older — drives the severity badge + sort order.
    severity: !r.last_season ? 'never' : (r.last_season === prevSeason(season) ? 'lapsed' : 'older'),
  }))

  const unmapped_teams = unmappedRes.rows.map((r) => ({
    team_id: r.id, name: r.name, sport: r.sport || '',
  }))

  const no_group = noGroupRes.rows.map((r) => ({
    member_id: r.member_id,
    member_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    clubdesk_id: r.clubdesk_id,
    teams: r.teams || '',
    kat: r.kat || '',
    // Teamless members fall back to the fee-category prefix.
    sport: r.sports || katSport(r.kat),
    has_team: !!r.teams,
  }))

  const missingByMember = foldByMember(missingRes.rows)

  const strays = strayRes.rows.map((r) => ({
    member_id: r.member_id,
    member_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    clubdesk_id: r.clubdesk_id,
    uuid: r.uuid || '',
    group: r.grp,
    sport: r.sports || '',
    // Only these are offered to "Fix groups"; the rest need a human to decide
    // whether the truth is "remove from ClubDesk" or "add the missing roster row".
    auto_removable: r.auto_removable === true,
    active: r.active === true,
    is_official: r.is_official === true,
    coach_of: r.coach_of || '',
    tr_of: r.tr_of || '',
  }))

  const no_team_groups = noTeamRes.rows.map((r) => ({ group: r.grp, count: r.cnt }))

  // One row per stale allocation (a member can hold the wrong Funktion on more
  // than one team), so this list IS the removal worklist — name/uuid/group are
  // exactly clubdesk-remove-group.mjs's three input fields.
  const stale_funktion = staleRes.rows.map((r) => ({
    member_id: r.member_id,
    member_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    // ClubDesk's grid renders and filters on "Nachname Vorname".
    clubdesk_name: [r.cd_nachname || r.last_name, r.cd_vorname || r.first_name].filter(Boolean).join(' '),
    clubdesk_id: r.clubdesk_id,
    uuid: r.uuid || '',
    group: r.stale_grp,
    expected: r.want_grp,
    sport: r.sport || '',
    is_guest: r.is_guest === true,
    has_correct: r.has_correct === true,
  }))

  const honorary_drift = honoraryRes.rows.map((r) => ({
    member_id: r.member_id,
    member_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
    clubdesk_id: r.clubdesk_id,
    register_status: r.register_status || '',
    kat: r.beitragskategorie || '',
    fee_waived: r.fee_waived === true,
    in_group: r.in_group === true,
    // 'status_only' → add them to the ClubDesk group (the honour list is
    // short one name). 'fee' → they hold the honour but are still billed.
    kind: r.in_group === true ? 'fee' : 'status_only',
  }))

  const flattenSports = (byMember) => [...byMember.values()]
    .map(({ sports, ...rest }) => ({ ...rest, sport: [...sports].sort().join(', ') }))

  return {
    missing: flattenSports(missingByMember),
    stale_funktion,
    strays,
    no_team_groups,
    no_group,
    coach_no_group: flattenSports(coachByMember),
    fee_no_roster,
    unmapped_teams,
    honorary_drift,
    season,
  }
  }

  router.get('/clubdesk-group-sync', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      return res.json(await computeGroupChecks())
    } catch (err) {
      log.error({ msg: `clubdesk-group-sync: ${err.message}`, endpoint: 'clubdesk-group-sync', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // ── On-demand "Fix groups" (headless ClubDesk UI automation) ────────────────
  // ClubDesk has no API and its CSV import treats `Gruppen` as a no-op, so the
  // ONLY way to write an allocation is to drive the real UI. Two proven scrapers
  // do that (clubdesk-scrape-groups.mjs = add, clubdesk-remove-group.mjs = remove);
  // Directus runs in a container and cannot launch either, so this uses the same
  // request-flag + host-dispatcher-cron handshake as the sync-down/up buttons.
  //
  // ⚠⚠ THE WORKLIST IS BUILT HERE, NEVER ACCEPTED FROM THE CLIENT. The request
  // body carries only which CLASSES of finding to act on; every row is recomputed
  // from computeGroupChecks() at queue time. A client-supplied worklist would make
  // a superadmin's browser an arbitrary write channel into the club's legal member
  // register — the operator chooses what to act on, never what a row means.
  //
  // ⚠ Recomputing at queue time also means the run acts on the CURRENT truth, not
  // on whatever the page last rendered. A finding fixed by somebody else in the
  // meantime simply is not in the list.
  const GROUP_FIX_CLASSES = ['missing', 'coach_no_group', 'stale_funktion', 'strays']
  // A normal week is 0–3 rows; the historic catch-up runs were ~49 (strays) and 29
  // (stale Funktion). Anything past this is a data fault, not a work list — the
  // same reasoning (and roughly the same number) as clubdesk-group-cleanup.sh's CAP.
  const GROUP_FIX_CAP = 120

  /**
   * Turn the current findings into the two scraper worklists.
   *
   * add    → clubdesk-scrape-groups.mjs  [{name, uuid, group, funktion, clubdesk_id}]
   * remove → clubdesk-remove-group.mjs   [{name, uuid, group_label}]
   *
   * Both tools filter the ClubDesk grid by `uuid` (the Wiedisync ID) because it is
   * unique and immune to the name drift that is normal in the register
   * ("Berke-Wenger" vs "Berke") — the clubdesk_id is NOT grid-searchable. A row
   * without a uuid therefore cannot be located safely and is dropped, not guessed.
   */
  function buildGroupFixWorklist(checks, classes) {
    const add = []
    const remove = []
    const skipped_no_uuid = []
    const wanted = new Set(classes)

    const pushAdds = (rows) => {
      for (const r of rows) {
        if (!r.uuid) { skipped_no_uuid.push(r.member_name); continue }
        for (const a of r.allocations || []) {
          add.push({
            name: r.clubdesk_name || r.member_name,
            uuid: r.uuid,
            group: a.group,
            funktion: a.funktion,
            clubdesk_id: r.clubdesk_id || '',
            member_id: r.member_id,
            label: a.label,
          })
        }
      }
    }

    if (wanted.has('missing')) pushAdds(checks.missing || [])
    if (wanted.has('coach_no_group')) pushAdds(checks.coach_no_group || [])

    if (wanted.has('stale_funktion')) {
      for (const r of checks.stale_funktion || []) {
        // ⚠ Only when the CORRECT token already sits alongside. Removing the last
        // token drops the member out of their team's group entirely until a human
        // re-adds it — worse than the contradiction it fixes. The rest stay visible
        // for a manual swap (they are in `missing` too, so the add half covers them).
        if (!r.has_correct) continue
        if (!r.uuid) { skipped_no_uuid.push(r.member_name); continue }
        remove.push({
          name: r.clubdesk_name || r.member_name,
          uuid: r.uuid,
          group_label: r.group,
          member_id: r.member_id,
        })
      }
    }

    if (wanted.has('strays')) {
      for (const r of checks.strays || []) {
        // ⚠ Only the auto-remove envelope: the member has LEFT the club, or still
        // belongs but staffs a team rather than playing on one. A plain member with
        // no roster row is AMBIGUOUS — usually a missing wiedisync roster row, not a
        // wrong ClubDesk group — and stripping them is how 29 DU20 girls were wiped
        // out of ClubDesk on 2026-07-16.
        if (!r.auto_removable) continue
        if (!r.uuid) { skipped_no_uuid.push(r.member_name); continue }
        remove.push({
          name: r.member_name,
          uuid: r.uuid,
          group_label: r.group,
          member_id: r.member_id,
        })
      }
    }

    return { add, remove, skipped_no_uuid }
  }

  /**
   * Identity of one worklist row, in the ONE shape both sides can produce.
   *
   * The scrapers echo back a subset of the worklist row (the add tool keeps
   * `group`/`funktion`/`clubdesk_id`, the remove tool keeps `uuid`/`group_label`),
   * so the key is built from exactly the fields that survive the round trip.
   */
  const addRowKey = (r) => `add|${String(r.clubdesk_id || '').trim()}|${r.group || ''}|${r.funktion || ''}`
  const removeRowKey = (r) => `remove|${String(r.uuid || '').trim()}|${r.group_label || ''}`

  /** Every row a preview reported — INCLUDING its skips, which were on screen too. */
  function previewedRowKeys(result) {
    const keys = new Set()
    for (const r of result?.add?.results || []) keys.add(addRowKey(r))
    for (const r of result?.remove?.results || []) keys.add(removeRowKey(r))
    return keys
  }

  router.get('/clubdesk-group-fix', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const s = await database('clubdesk_member_sync').where('id', 1).first(
        'grp_state', 'grp_message', 'grp_mode', 'grp_requested_at', 'grp_finished_at',
        'grp_worklist', 'grp_result', 'grp_requested_by_name',
        'grp_phase', 'grp_progress', 'grp_log',
        'down_state', 'up_state')
      const parse = (v) => (typeof v === 'string' ? (() => { try { return JSON.parse(v) } catch { return null } })() : (v ?? null))
      const worklist = parse(s?.grp_worklist)
      return res.json({
        state: s?.grp_state || 'idle',
        message: s?.grp_message || null,
        mode: s?.grp_mode || null,
        requested_at: s?.grp_requested_at || null,
        finished_at: s?.grp_finished_at || null,
        requested_by: s?.grp_requested_by_name || null,
        counts: worklist
          ? { add: (worklist.add || []).length, remove: (worklist.remove || []).length }
          : null,
        worklist,
        result: parse(s?.grp_result),
        // Live progress (migration 355) — advisory, may be null. The group tools
        // report per CONTACT, so this bar actually crawls through the worklist.
        phase: s?.grp_phase || null,
        progress: s?.grp_progress == null ? null : Number(s.grp_progress),
        log: s?.grp_log || null,
        // The other two directions block this one and vice versa (see below).
        down_state: s?.down_state || 'idle',
        up_state: s?.up_state || 'idle',
      })
    } catch (err) {
      log.error({ msg: `clubdesk-group-fix status: ${err.message}`, endpoint: 'clubdesk-group-fix', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/clubdesk-group-fix', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })

      const mode = req.body?.mode === 'commit' ? 'commit' : 'preview'
      const classes = Array.isArray(req.body?.classes) && req.body.classes.length
        ? req.body.classes.filter((c) => GROUP_FIX_CLASSES.includes(c))
        : GROUP_FIX_CLASSES
      if (!classes.length) return res.status(400).json({ error: 'No valid fix classes requested' })

      const s = await database('clubdesk_member_sync').where('id', 1)
        .first('grp_state', 'grp_mode', 'grp_result', 'down_state', 'up_state')
      if (isBusy(s?.grp_state)) {
        return res.status(409).json({ error: 'A group fix is already in progress', state: s.grp_state, code: 'grp_in_progress' })
      }
      // Same mutual exclusion as down↔up, for the same reason: every ClubDesk
      // scrape shares ONE login (the blocking .sync.lock serialises them on the
      // host), and this run's worklist is computed against `clubdesk_export`. A
      // sync-down landing mid-run would swap that snapshot out underneath it.
      if (isBusy(s?.down_state)) {
        return res.status(409).json({ error: 'A sync-down is in progress — wait for it to finish', state: s.down_state, code: 'down_in_progress' })
      }
      if (isBusy(s?.up_state)) {
        return res.status(409).json({ error: 'A sync-up is in progress — wait for it to finish', state: s.up_state, code: 'up_in_progress' })
      }

      // ⚠ A commit must be preceded by a SUCCESSFUL preview of the same shape. The
      // preview is what the operator approved; without this gate a caller could
      // POST mode=commit as its very first request and write straight to the legal
      // register with nothing reviewed. Mirrors the sync-up's dry-run-then-commit
      // gate (clubdesk-member-up-dispatch.sh).
      let previewedKeys = null
      if (mode === 'commit') {
        const prev = typeof s?.grp_result === 'string'
          ? (() => { try { return JSON.parse(s.grp_result) } catch { return null } })()
          : s?.grp_result
        if (s?.grp_mode !== 'preview' || !prev) {
          return res.status(409).json({
            error: 'Run a preview first — a commit writes to the club register',
            code: 'preview_required',
          })
        }
        previewedKeys = previewedRowKeys(prev)
      }

      const checks = await computeGroupChecks()
      const { add, remove, skipped_no_uuid } = buildGroupFixWorklist(checks, classes)
      const total = add.length + remove.length

      // ⚠ A commit may only write rows the operator ACTUALLY SAW. The gate above
      // asks "was the last run a preview", which is not the same question: the
      // worklist is recomputed here from the CURRENT request, so ticking another
      // class after a preview — or a roster edit landing in between — produced a
      // commit of rows nobody had reviewed, with the confirm dialog still counting
      // the old preview's rows. Comparing the recomputed worklist against the
      // preview's own per-row result closes both, and is stricter than comparing
      // the requested classes would be. A SHRUNK worklist is fine (those rows were
      // fixed elsewhere); anything NEW means the preview no longer describes this
      // run, so it has to be run again.
      if (previewedKeys) {
        const unseen = [...add.map(addRowKey), ...remove.map(removeRowKey)]
          .filter((k) => !previewedKeys.has(k))
        if (unseen.length) {
          return res.status(409).json({
            error: `${unseen.length} of these changes were not in the preview — run the preview again`,
            code: 'preview_stale', unseen: unseen.length,
          })
        }
      }
      if (!total) {
        return res.status(409).json({ error: 'Nothing to fix', code: 'empty_worklist', skipped_no_uuid })
      }
      // Runaway guard. A blown cap means the inputs are wrong (an empty roster, a
      // half-loaded clubdesk_export), and the correct response to that is never
      // "write 400 allocations into the register".
      if (total > GROUP_FIX_CAP) {
        return res.status(409).json({
          error: `${total} changes exceed the safety cap of ${GROUP_FIX_CAP} — review the findings first`,
          code: 'cap_exceeded', total, cap: GROUP_FIX_CAP,
        })
      }

      const actor = await resolveActingUser(req)
      await database('clubdesk_member_sync').where('id', 1).update({
        grp_requested_at: new Date(),
        grp_state: 'queued',
        grp_mode: mode,
        grp_message: null,
        grp_finished_at: null,
        grp_worklist: JSON.stringify({ add, remove, classes, skipped_no_uuid }),
        // Cleared on queue so the UI can never show a previous run's outcome next
        // to a new run's state — and so the commit gate above cannot be satisfied
        // twice by one preview.
        grp_result: null,
        // ⚠ The progress trio is cleared HERE, not only by the dispatcher's
        // cdp_reset. The dispatchers run on a one-minute cron, so between the
        // click and the claim a queued job rendered the PREVIOUS run's phase, its
        // 100% bar and its whole log — a dialog that opens on "Synced from
        // ClubDesk · 100%" two seconds after you asked for a fresh sync
        // (08.09.2026). cdp_reset stays as the belt-and-braces for a run the
        // dispatcher picks up some other way.
        grp_phase: null, grp_progress: 0, grp_log: null,
        grp_requested_by_name: actor.name,
        grp_requested_by_email: actor.email,
      })
      // Raw-knex write → no Directus revision trail, so the actor is captured
      // explicitly (CLAUDE.md → Audit logging). A commit edits the club's legal
      // member register; "who ran it" is the whole point.
      await writeUserLog(database, log, {
        accountability: req.accountability, action: 'update',
        collection: 'clubdesk_member_sync', recordId: 1,
        data: { kind: 'clubdesk_group_fix_request', mode, classes, add: add.length, remove: remove.length },
      })
      return res.json({ state: 'queued', mode, counts: { add: add.length, remove: remove.length }, skipped_no_uuid })
    } catch (err) {
      log.error({ msg: `clubdesk-group-fix trigger: ${err.message}`, endpoint: 'clubdesk-group-fix', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // Deactivate a departed member: not-a-member + inactive, and drop their
  // current-season team assignments (keep prior-season history). Superadmin.
  /**
   * The departed check, re-run for ONE member at the moment of the write.
   *
   * ⚠ Never trust the list the caller acted on. Data Health is a scan taken minutes
   * or hours ago, and this call deactivates a person and strips their rosters. Three
   * conditions, all re-read here: the member is linked; the `clubdesk_id` maps 1:1
   * (a shared id would deactivate the WRONG person); and the linked contact is STILL
   * in a departed status with an Austritt date — the same predicate as
   * /clubdesk-departed.
   *
   * Returns null when it may proceed, or a `{ code }` refusal. Lifted out of the
   * route so the bulk form applies the identical gate per member rather than a
   * looser one — a bulk action that checks less than its single-row twin is how a
   * careful guard gets bypassed by the convenient button.
   */
  async function departureRefusal(memberId) {
    const member = await database('members').where('id', memberId).first('id', 'clubdesk_id')
    if (!member) return { code: 'not_found' }
    if (!member.clubdesk_id) return { code: 'not_linked' }
    const sharing = await database('members').where('clubdesk_id', member.clubdesk_id).count('id as n').first()
    if (Number(sharing?.n) !== 1) return { code: 'ambiguous_link' }
    const departed = await database('clubdesk_export')
      .whereRaw('BTRIM(clubdesk_id) = ?', [member.clubdesk_id])
      .whereIn(database.raw('BTRIM(status)'), DEPARTED_STATUSES)
      .whereRaw("NULLIF(BTRIM(austritt), '') IS NOT NULL")
      .first('clubdesk_id')
    if (!departed) return { code: 'not_departed' }
    return null
  }

  const DEACTIVATE_BULK_CAP = 200

  const DEACTIVATE_REFUSALS = {
    not_found: 'Member not found',
    not_linked: 'Member is not linked to a ClubDesk contact',
    ambiguous_link: 'clubdesk_id is shared by multiple members — resolve the duplicate link first',
    not_departed: 'ClubDesk contact is not in a departed status — refresh Data Health',
  }

  /**
   * Deactivate a member (or several) whose ClubDesk contact says they have left.
   *
   * Takes `member_id` (one) or `member_ids` (up to 200). ⚠ The bulk form is a LOOP,
   * not a set-based write: every member goes through the same `departureRefusal`
   * gate and the same `deactivateMemberRow` (which writes its own `user_logs` entry),
   * so a bulk run is auditable member by member exactly like the single one.
   *
   * ⚠ Partial success is the normal outcome and is reported as such — a member whose
   * link turned ambiguous since the scan is SKIPPED while the rest proceed. Failing
   * the whole batch on one bad row would make the button useless on the day it
   * matters; silently counting it as done would deactivate nobody and say it had.
   */
  router.post('/clubdesk-deactivate', async (req, res) => {
    try {
      if (!(await superGate(req))) return res.status(403).json({ error: 'Forbidden' })
      const bulk = Array.isArray(req.body?.member_ids)
      const ids = bulk
        ? [...new Set(req.body.member_ids.map(Number).filter(Number.isInteger))]
        : [Number(req.body?.member_id)].filter(Number.isInteger)
      if (!ids.length) return res.status(400).json({ error: 'member_id or member_ids required' })
      if (ids.length > DEACTIVATE_BULK_CAP) {
        return res.status(400).json({ error: `Too many members (max ${DEACTIVATE_BULK_CAP})`, code: 'too_many' })
      }

      const deactivated = []
      const skipped = []
      let dropped = 0
      for (const memberId of ids) {
        const refusal = await departureRefusal(memberId)
        if (refusal) {
          // The single-member form keeps its original status codes, so the existing
          // per-row button behaves exactly as before.
          if (!bulk) {
            const status = refusal.code === 'not_found' ? 404 : 409
            return res.status(status).json({ error: DEACTIVATE_REFUSALS[refusal.code], code: refusal.code })
          }
          skipped.push({ member_id: memberId, code: refusal.code })
          continue
        }
        // ⚠ Deletes rosters by MEMBERSHIP, not by season string — see
        // deactivateMemberRow, which the broken-link flow shares.
        dropped += await deactivateMemberRow(req, memberId, 'clubdesk_deactivate')
        deactivated.push(memberId)
      }
      if (!bulk) {
        return res.json({ success: true, member_id: ids[0], rosters_dropped: dropped })
      }
      return res.json({
        success: true, deactivated, skipped, rosters_dropped: dropped,
      })
    } catch (err) {
      log.error({ msg: `clubdesk-deactivate: ${err.message}`, endpoint: 'clubdesk-deactivate', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  router.post('/clubdesk-update', async (req, res) => {
    try {
      // Auth check
      const userId = req.accountability?.user
      if (!userId) return res.status(401).json({ error: 'Authentication required' })

      const { member_id, changes } = req.body
      if (!member_id || !changes?.length) {
        return res.status(400).json({ error: 'member_id, changes required' })
      }

      // Verify ownership + fetch the caller's OWN row from the DB. The emailed CSV
      // and the change diff are built from THESE authoritative values, never from
      // client-supplied current_data (2026-07-05 audit #9): a member could
      // otherwise forge an AHV / Beitragskategorie / Anrede into an
      // official-looking "apply this in ClubDesk" email + CSV. ClubDesk-owned
      // fields (anrede / nationalitaet / ahv_nummer / beitragskategorie) are never
      // sent from here — the member self-service path stays contact-basics only
      // (the sync-up push carries anrede/nationalitaet/ahv since 2026-07-07, but
      // echo-protected and superadmin-gated, not member-editable).
      const member = await database('members').where('user', userId)
        .first('id', 'first_name', 'last_name', 'email', 'phone', 'adresse', 'plz', 'ort', 'birthdate', 'sex',
          // Member-editable since 2026-07-25 (migrations 223/228): nationality is
          // a derived German string over a code list, federation_of_origin an ISO
          // code. The email renders the CODES, so both columns are read here.
          'nationalitaet', 'nationalitaet_codes', 'federation_of_origin',
          // Member-editable since 2026-08-03 (migration 274). Stored as codes; the
          // email renders them, ClubDesk gets its own wording.
          'trainer_licences')
      if (!member || String(member.id) !== String(member_id)) {
        return res.status(403).json({ error: 'Forbidden' })
      }

      // Rate limit (audit #12) — 5 / hour / member.
      const nowMs = Date.now()
      const rl = clubdeskUpdateRl.get(member.id)
      if (rl && nowMs < rl.resetAt) {
        if (rl.count >= 5) return res.status(429).json({ error: 'Too many update requests — try again later' })
        rl.count++
      } else {
        clubdeskUpdateRl.set(member.id, { count: 1, resetAt: nowMs + 60 * 60 * 1000 })
      }
      if (clubdeskUpdateRl.size > 5000) { for (const [k, v] of clubdeskUpdateRl) if (nowMs > v.resetAt) clubdeskUpdateRl.delete(k) }

      // Whitelist the change diff to member-editable fields (drop any client-sent
      // ClubDesk-authoritative field) and rebuild each "new" value from the DB row
      // so the email shows the real stored value, not a client claim.
      // ⚠ A field the profile form DIFFS but this set omits makes a change to
      // ONLY that field return 400 "No editable fields to update" — the member
      // sees an error toast even though their save succeeded. That is exactly
      // what happened to nationality (silently, since before 2026-07-25) and then
      // to federation_of_origin on the day it shipped. Keep this set in step with
      // `clubdeskFields` in ProfileEditForm.tsx.
      const EDITABLE = new Set(['first_name', 'last_name', 'email', 'phone', 'birthdate',
        'adresse', 'plz', 'ort', 'sex', 'nationalitaet', 'federation_of_origin',
        'trainer_licences'])
      const sexLabel = sexPushLabel(member.sex)

      // Team names for the CSV + the member's sport, which the federation label
      // needs (an Italian volleyballer came from FIPAV, an Italian basketballer
      // from FIP) — hence fetched BEFORE the change diff is rendered.
      const schema = await getSchema()
      const { ItemsService, MailService } = services
      const mtService = new ItemsService('member_teams', { schema, knex: database })
      const memberTeams = await mtService.readByQuery({
        filter: { member: { _eq: member_id }, season: { _eq: getCurrentSeason() } },
        fields: ['team.name', 'team.sport'],
      })
      // Dedupe by team name (defensive — a member can hold the same team across
      // multiple seasons; the season filter already scopes to the current one).
      const teamNames = [...new Set(
        memberTeams.map(mt => mt.team?.name).filter(Boolean)
      )].join(', ')

      // Determine sport for email accent
      const teamSports = memberTeams.map(mt => mt.team?.sport).filter(Boolean)
      const sport = teamSports.includes('volleyball') ? 'volleyball'
        : teamSports.includes('basketball') ? 'basketball' : null
      // …but a member who plays BOTH has no single right federation, so they get
      // the plain country name — same rule as `fedSport` in ProfileEditForm.tsx,
      // which is what the member picked from.
      const fedSport = teamSports.includes('volleyball') && teamSports.includes('basketball')
        ? undefined : (sport ?? undefined)

      // Country/federation values arrive and are stored as CODES, so each change
      // is rendered TWICE from the same raw value: once German for ClubDesk (the
      // persisted push diff + the sync-up modal) and once per recipient language
      // for the email. Rendering client-side instead froze every email into the
      // *member's* language — an English-speaking admin read "Schweiz".
      const countryNames = await loadCountryPushNames(database)   // ClubDesk picklist spellings
      const countryDisp = await loadCountryDisplayNames(database) // reader-facing names
      const rawChanges = (Array.isArray(changes) ? changes : [])
        .filter((c) => c && EDITABLE.has(c.field))
        .map((c) => ({
          field: c.field,
          old: c.old_value,
          // The NEW side always comes from the DB row, never the client's claim
          // (2026-07-05 audit #9).
          new: c.field === 'nationalitaet' ? (member.nationalitaet_codes ?? '')
            : (member[c.field] ?? ''),
        }))
      if (!rawChanges.length) {
        return res.status(400).json({ error: 'No editable fields to update' })
      }
      // Old birthdate arrives as ISO from the modal — render it Swiss like the
      // new value (the Lasse email showed "2024-04-17" vs "17.04.1998"). Anything
      // unparseable passes through rather than blanking the cell.
      const fmtBd = (v) => fmtBirthdateDDMMYYYY(v) || String(v ?? '')
      /** ClubDesk-facing (German) value — persisted diff + sync-up modal. */
      const pushValue = (field, v) =>
        field === 'birthdate' ? fmtBd(v)
          : field === 'sex' ? sexPushLabel(v)
            : field === 'nationalitaet' ? nationalityCell(v, countryNames)
              : field === 'federation_of_origin' ? federationCell(v, countryNames)
                : field === 'trainer_licences' ? trainerLicenceCell(v)
                  : String(v ?? '')
      /** Reader-facing value in `loc` — the admin email only, never ClubDesk. */
      const displayValue = (field, v, loc) =>
        field === 'birthdate' ? fmtBd(v)
          : field === 'sex' ? sexDisplay(v, loc)
            : field === 'nationalitaet' ? countryCodesDisplay(v, loc, countryDisp)
              : field === 'federation_of_origin' ? federationDisplay(v, fedSport, loc, countryDisp)
                : field === 'trainer_licences' ? trainerLicenceDisplay(v, loc)
                  : String(v ?? '')
      const safeChanges = rawChanges.map((c) => ({
        field: c.field,
        old_value: pushValue(c.field, c.old),
        new_value: pushValue(c.field, c.new),
      }))

      // Build email — per-recipient locale via members.language. Authoritative
      // CSV from the DB row; ClubDesk-owned fields (anrede/nationalitaet/ahv/
      // beitragskategorie) blanked so they can never be forged or overwritten.
      const safeData = {
        anrede: '', first_name: member.first_name, last_name: member.last_name,
        email: member.email, phone: member.phone, adresse: member.adresse,
        plz: member.plz, ort: member.ort, birthdate: fmtBirthdateDDMMYYYY(member.birthdate),
        nationalitaet: '', sex: sexLabel, ahv_nummer: '', beitragskategorie: '',
      }
      const name = `${member.first_name} ${member.last_name}`
      const csvString = buildCsv(safeData, teamNames)
      const dateStr = new Date().toISOString().slice(0, 10)
      const filename = `clubdesk-update-${member.last_name}-${member.first_name}-${dateStr}.csv`

      const mail = new MailService({ schema, knex: database })

      // OWNER_EMAIL is a real admin's mailbox (resolves via members.language).
      // ADMIN_EMAIL is a forwarding alias (kontakt@kscw.ch) without a member
      // record, so the bucketing helper would fall it into `de`. To prevent
      // a duplicate German copy reaching the same admin via the alias, we
      // mirror ADMIN_EMAIL into the same locale bucket as OWNER_EMAIL.
      const ownerBuckets = await bucketEmailsByLocale(database, [OWNER_EMAIL])
      const ownerLocale = CD_LOCALES.find(l => ownerBuckets[l].length) || 'de'
      const buckets = await bucketEmailsByLocale(database, [OWNER_EMAIL])
      // Add ADMIN_EMAIL to the owner's resolved bucket (deduplicated)
      const adminLower = ADMIN_EMAIL.toLowerCase()
      if (adminLower !== OWNER_EMAIL.toLowerCase() && !buckets[ownerLocale].includes(adminLower)) {
        buckets[ownerLocale].push(adminLower)
      }

      for (const loc of CD_LOCALES) {
        const tos = buckets[loc]
        if (!tos.length) continue
        const tt = T[loc] || T.de
        const summaryCard = buildInfoCard([
          { label: tt.name, value: name, halfWidth: true },
          { label: tt.email, value: member.email, halfWidth: true },
          { label: tt.phone, value: member.phone || '—', halfWidth: true },
          { label: tt.team, value: teamNames || '—', halfWidth: true },
        ])
        // Re-rendered per bucket: the same stored 'CH' reads "🇨🇭 Swiss Volley"
        // to every admin and "Switzerland"/"Schweiz" where no federation is
        // mapped, while ClubDesk keeps the German picklist value in safeChanges.
        const locChanges = rawChanges.map((c) => ({
          field: c.field,
          old_value: displayValue(c.field, c.old, loc),
          new_value: displayValue(c.field, c.new, loc),
        }))
        const body = `
<div style="font-size:13px;color:#94a3b8;margin-bottom:12px">${tt.intro}</div>
${buildChangesTable(locChanges, loc)}
<div style="margin-top:16px">
  <div style="font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.5px;margin-bottom:8px;font-weight:700">${tt.currentData}</div>
  ${summaryCard}
</div>`
        const emailHtml = buildEmailLayout(body, { title: tt.title, subtitle: name, sport })
        await mail.send({
          to: tos,
          subject: tt.subject(name),
          html: emailHtml,
          attachments: [{ filename, content: toCp1252Buffer(csvString), contentType: 'text/csv; charset=windows-1252' }],
        })
      }

      // Flag the member for the next ClubDesk sync-up push and remember the field
      // diff (the superadmin modal echoes it). The email-to-admin path stays as the
      // manual fallback; the flag enables the automated push. Best-effort — a flag
      // failure must not fail the member's edit.
      try {
        // MERGE, don't replace. The same profile save writes members first, and
        // the members.update hook records `iban` / `ahv_nummer` there (this
        // endpoint refuses both as ClubDesk-authoritative, so they can only
        // arrive that way). Stringifying safeChanges over the top dropped those
        // entries, and the superadmin sync-up modal then under-reported what the
        // push was about to carry — the CSV itself is rebuilt from the members
        // row, so nothing was ever mis-pushed, only mis-displayed.
        let merged = []
        try {
          const prev = await database('members').where('id', member_id).first('clubdesk_push_changes')
          merged = Array.isArray(prev?.clubdesk_push_changes) ? prev.clubdesk_push_changes
            : (prev?.clubdesk_push_changes ? JSON.parse(prev.clubdesk_push_changes) : [])
        } catch { merged = [] }
        const nowFields = new Set(safeChanges.map((c) => c.field))
        merged = merged.filter((c) => c?.field && !nowFields.has(c.field)).concat(safeChanges)
        await database('members').where('id', member_id).update({
          clubdesk_push_pending: true,
          clubdesk_push_changes: JSON.stringify(merged),
        })
        // Audit: this raw-knex write bypasses Directus's activity/revision trail,
        // so record WHO flagged the member for the next ClubDesk sync-up push.
        await writeUserLog(database, log, {
          accountability: req.accountability, action: 'update',
          collection: 'members', recordId: member_id,
          data: { kind: 'clubdesk_push_flag', fields: safeChanges.map((c) => c.field) },
        })
      } catch (flagErr) {
        log.warn({ msg: `clubdesk push-flag failed: ${flagErr.message}`, member_id })
      }

      log.info({ msg: 'ClubDesk update email sent', member_id, changes: safeChanges.length })
      res.json({ success: true })
    } catch (err) {
      log.error({
        msg: `clubdesk-update: ${err.message}`,
        endpoint: 'clubdesk-update',
        stack: err.stack,
      })
      res.status(500).json({ error: 'Internal error' })
    }
  })
}
