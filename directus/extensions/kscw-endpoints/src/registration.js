/**
 * Registration Form — unified member registration (VB/BB/Passive)
 * POST /kscw/registration — public, Turnstile protected
 * POST /kscw/registration/:id/files — public, upload ID files after registration
 */

import { buildEmailLayout, buildInfoCard, formatDateCH, bucketEmailsByLocale, escHtml } from './email-template.js'
import { normalizePhone, normalizeIban, normalizeAhv, normalizeEmail, titleCaseName } from './normalize.js'
import { BB_SITUATIONS, bbRequiredDocs, bbRequiredDocsAfterWaiver, fibaNatCode } from './bb-docs.js'
import { BB_PDF_TEMPLATES, fillBbForm } from './bb-pdf-fill.js'
import { federationName } from './federations.js'
import { writeUserLog } from './activity-log.js'
import {
  findDuplicateCandidates, findDuplicateCandidatesBatch, findBlockingMember,
  buildMergeDiff, buildMergePatch,
} from './registration-duplicates.js'
import { loadTemplate, mergeTemplate, renderTemplate, sanitizeTemplateHtml, recordEmailSend, validateTemplate } from './email-templates.js'
import crypto from 'crypto'
import { streamManagedFile } from './storage-read.js'
import { Transform } from 'node:stream'

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || ''

// Club admin mailbox — a real monitored inbox with an in-app tab (/admin/mailbox),
// NOT a personal address. It is the reply-to on everything the club sends a family,
// so a reply has to land somewhere the club actually reads.
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'admin@wiedisync.kscw.ch'

/**
 * Look up sport admin emails from the members table.
 * VB registration → members with role containing 'vb_admin'
 * BB registration → members with role containing 'bb_admin'
 * Passive / fallback → OWNER_EMAIL
 * Global admins (admin/superuser) are always included.
 */
async function getSportAdminEmails(database, membershipType) {
  const adminRole = membershipType === 'volleyball' ? 'vb_admin'
    : membershipType === 'basketball' ? 'bb_admin'
    : null

  // Get global admins (admin or superuser role) + sport-specific admins
  const rows = await database('members')
    .join('directus_users', 'members.user', 'directus_users.id')
    .whereNotNull('directus_users.email')
    // Migration 156: skip admins who opted out of new-registration emails.
    .where('members.email_notify_registrations', true)
    .andWhere(function () {
      this.whereRaw("members.role::jsonb @> '\"admin\"'")
        .orWhereRaw("members.role::jsonb @> '\"superuser\"'")
      if (adminRole) {
        this.orWhereRaw("members.role::jsonb @> ?", [JSON.stringify(adminRole)])
      }
    })
    .select('directus_users.email')

  const emails = [...new Set(rows.map(r => r.email.toLowerCase()))]
  return emails.length ? emails : [OWNER_EMAIL]
}

async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) {
    console.error('[registration] TURNSTILE_SECRET not configured — rejecting request')
    return false
  }
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token) }).toString(),
  })
  return (await resp.json()).success === true
}

function generateRefNumber() {
  const now = new Date()
  const y = now.getFullYear()
  const rand = String(1000 + (crypto.randomBytes(2).readUInt16BE(0) % 9000))
  return `REG-${y}-${rand}`
}

// ── Coded nationality / federation (migration 223) ──────────────
// Both columns carry a CHECK constraint, and this route is an ANONYMOUS POST:
// anything the public form sends that the regex rejects would surface as a 500
// on a member's submission instead of a validation message. So normalize hard
// and drop what doesn't fit rather than trusting the client.

/** Ordered, de-duplicated ISO 3166-1 alpha-2 list ("CH,IT"); first = primary.
 *  Order is meaningful (the primary code is what ClubDesk gets), so dedupe
 *  must preserve it. Empty selection stores NULL, never ''. */
function normalizeCountryCodes(raw) {
  const codes = [...new Set(
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]{2}$/.test(s)),
  )]
  return codes.length ? codes.join(',') : null
}

/** Federation of origin: an ISO alpha-2 code, or NULL ("didn't answer").
 *
 *  ⚠ 'NONE' is a RETIRED sentinel (migration 342) and the column's CHECK no
 *  longer accepts it. It is mapped to 'CH' rather than rejected because that is
 *  what it meant: nobody has licensed this applicant yet, so their first licence
 *  is the one being issued here and Swiss Volley / Swiss Basketball IS their
 *  federation of origin. A cached form bundle can still send it — that is
 *  exactly how REG-2026-6400 arrived NULL the day the client gate shipped — and
 *  a 400 at that point costs the applicant everything they typed. */
export function normalizeFederation(raw) {
  const v = String(raw ?? '').trim().toUpperCase()
  if (v === 'NONE') return 'CH'
  return /^[A-Z]{2}$/.test(v) ? v : null
}

/** A volleyball licence needs an explicit federation-of-origin answer — a
 *  federation code; NULL leaves the club guessing whether a transfer
 *  certificate must be chased. Guests are never licensed,
 *  so they are exempt. Second enforcement point after the client form gate
 *  (kscw-website registration-form.js, 2026-07-27) — server-side because
 *  REG-2026-6400 arrived NULL from a stale cached bundle the day after that
 *  gate shipped. */
export function vbFederationMissing(membershipType, isGuest, federationOfOrigin) {
  return membershipType === 'volleyball' && !isGuest && !federationOfOrigin
}

// ── Confirmation emails ─────────────────────────────────────────

// ── i18n strings for emails ────────────────────────────────────
// Five locales: de | gsw (Swiss German) | en | fr | it.
// Long bodies (vbBody/bbBody/passiveBody) are paragraph-length;
// short labels follow the field naming convention used elsewhere in the app.
const VB_FEE_LINES = {
  de: 'Erwerbstätige: CHF 440.–<br>Studenten/Studentinnen / Lernende: CHF 380.–<br>Schüler/Schülerinnen (Meisterschaft): CHF 310.–<br>Schüler/Schülerinnen (nur Turniere): CHF 210.–<br>Schüler/Schülerinnen (nur Turniere, 1. Saison): CHF 110.–',
  gsw: 'Erwärbstätigi: CHF 440.–<br>Studänte / Lehrlig: CHF 380.–<br>Schüeler (Meisterschaft): CHF 310.–<br>Schüeler (nur Turnier): CHF 210.–<br>Schüeler (nur Turnier, 1. Saison): CHF 110.–',
  en: 'Working adults: CHF 440.–<br>Students / apprentices: CHF 380.–<br>Pupils (championship): CHF 310.–<br>Pupils (tournaments only): CHF 210.–<br>Pupils (tournaments only, 1st season): CHF 110.–',
  fr: 'Personnes actives : CHF 440.–<br>Étudiant·e·s / apprenti·e·s : CHF 380.–<br>Élèves (championnat) : CHF 310.–<br>Élèves (tournois uniquement) : CHF 210.–<br>Élèves (tournois uniquement, 1ʳᵉ saison) : CHF 110.–',
  it: 'Adulti che lavorano: CHF 440.–<br>Studenti / apprendisti: CHF 380.–<br>Allievi (campionato): CHF 310.–<br>Allievi (solo tornei): CHF 210.–<br>Allievi (solo tornei, 1ª stagione): CHF 110.–',
}

const T = {
  de: {
    greeting: name => `Hallo ${name},`,
    vbTitle: 'Willkommen beim KSC Wiedikon!',
    vbSubtitle: 'Deine Volleyball-Anmeldung ist eingegangen',
    vbSubject: 'Willkommen beim KSC Wiedikon — Volleyball',
    vbFooter: 'Sportliche Grüsse — KSC Wiedikon Volleyball',
    vbFeeHeader: 'Mitgliederbeiträge',
    vbBody: `<p>Bitte beachte, dass der Lizenzierungsprozess ab Zahlung des Mitgliederbeitrags mind. eine Woche dauert.</p>
      <p>Du erhältst in den nächsten Tagen (oder im August, der Hauptrechnungsperiode) eine Rechnung von uns. Deine Lizenz wird erst bestellt, wenn der Beitrag beim KSCW eingetroffen ist — also einfach möglichst bald einzahlen.</p>
      <p>Neu musst du dir unter <a href="https://volleymanager.volleyball.ch/login" style="color:#FFC832">volleymanager.volleyball.ch</a> ein Login erstellen, falls du noch keines besitzt.</p>
      <p>Bei Fragen zum Club, deinem Team oder dem Lizenzierungsprozess kann dir dein Coach oder auch wir gerne Auskunft geben.</p>`,
    bbTitle: 'Anmeldung eingegangen',
    bbSubtitle: 'KSC Wiedikon Basketball',
    bbSubject: 'Anmeldung eingegangen — KSC Wiedikon Basketball',
    bbFooter: 'KSC Wiedikon Basketball',
    bbBody: `<p>Deine Anmeldung wird von unserem Admin-Team geprüft. Du wirst benachrichtigt, sobald sie genehmigt wurde.</p>
      <p><strong style="color:#e2e8f0">Nächste Schritte:</strong></p>
      <ul style="padding-left:20px;margin:8px 0">
        <li>Stelle sicher, dass du deine ID-Kopie (Vorder- und Rückseite) hochgeladen hast</li>
        <li>Der Lizenzantrag wird vom Admin vorbereitet</li>
        <li>Die Bearbeitung dauert in der Regel einige Werktage</li>
      </ul>
      <p>Bei Fragen wende dich an deinen Coach oder an <a href="mailto:kontakt@kscw.ch" style="color:#F97316">kontakt@kscw.ch</a>.</p>`,
    passiveTitle: 'Passivmitgliedschaft',
    passiveSubtitle: 'Anmeldung eingegangen',
    passiveSubject: 'Passivmitgliedschaft — KSC Wiedikon',
    passiveBody: `<p>Deine Anmeldung als Passivmitglied ist eingegangen und wird geprüft.</p>
      <p>Du erhältst in den nächsten Tagen eine Rechnung für den Passivmitgliederbeitrag (CHF 40.–).</p>
      <p>Bei Fragen erreichst du uns unter <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
    name: 'Name', team: 'Team', fee: 'Beitragskategorie', dob: 'Geburtsdatum',
    email: 'E-Mail', phone: 'Telefon', address: 'Adresse', nationality: 'Nationalität',
    gender: 'Geschlecht', licence: 'Lizenz', refLevel: 'Schiedsrichter-Stufe', ref: 'Referenz',
    adminTitle: 'Neue Anmeldung',
    adminCta: 'Im Admin prüfen',
    adminSubject: (vorname, nachname, type) => `[KSCW] Neue Anmeldung: ${vorname} ${nachname} (${type})`,
    adminType: 'Typ', adminAhv: 'AHV', adminKantonsschule: 'Kantonsschule', adminBemerkungen: 'Bemerkungen',
    adminNextSteps: 'Nächste Schritte:',
    adminStep1: 'Daten im Admin-Bereich prüfen und ggf. bearbeiten',
    adminStep2: 'Anmeldung bestätigen oder ablehnen',
    adminStep3: 'Nach Bestätigung wird automatisch eine CSV-Datei generiert',
  },
  gsw: {
    greeting: name => `Hoi ${name},`,
    vbTitle: 'Willkomme bim KSC Wiedikon!',
    vbSubtitle: 'Dini Volleyball-Aamäldig isch agcho',
    vbSubject: 'Willkomme bim KSC Wiedikon — Volleyball',
    vbFooter: 'Sportlichi Grüess — KSC Wiedikon Volleyball',
    vbFeeHeader: 'Mitgliederbyträg',
    vbBody: `<p>Bitte beachte, dass de Lizenzierigsprozess ab dr Zahlig vom Mitgliederbytrag mind. ä Wuche dauert.</p>
      <p>Du überchunsch i de nächste Täg (oder im Auguscht, dr Haupträchnigsperiode) ä Rächnig vo eus. Dini Lizenz wird erst bstellt, wenn de Bytrag bim KSCW aacho isch — also eifach so schnäll wie möglich yzahle.</p>
      <p>Neu muesch dir under <a href="https://volleymanager.volleyball.ch/login" style="color:#FFC832">volleymanager.volleyball.ch</a> ä Login mache, falls du no kä hesch.</p>
      <p>Bi Frage zum Club, dym Team oder em Lizenzierigsprozess cha dir dini Trainerin oder dr Trainer oder au mir gärn Uskunft geh.</p>`,
    bbTitle: 'Aamäldig agcho',
    bbSubtitle: 'KSC Wiedikon Basketball',
    bbSubject: 'Aamäldig agcho — KSC Wiedikon Basketball',
    bbFooter: 'KSC Wiedikon Basketball',
    bbBody: `<p>Dini Aamäldig wird vo eusem Admin-Team prüeft. Du wirsch informiert, sobald si bewilligt isch.</p>
      <p><strong style="color:#e2e8f0">Nächsti Schritt:</strong></p>
      <ul style="padding-left:20px;margin:8px 0">
        <li>Stell sicher, dass du dini ID-Kopie (Vorder- und Rückseite) ufeglade hesch</li>
        <li>De Lizenzaatrag wird vom Admin vorbereitet</li>
        <li>D Bearbeitig dauert i de Regle ä paar Werchtäg</li>
      </ul>
      <p>Bi Frage chunsch zu dym Coach oder a <a href="mailto:kontakt@kscw.ch" style="color:#F97316">kontakt@kscw.ch</a>.</p>`,
    passiveTitle: 'Passivmitgliedschaft',
    passiveSubtitle: 'Aamäldig agcho',
    passiveSubject: 'Passivmitgliedschaft — KSC Wiedikon',
    passiveBody: `<p>Dini Aamäldig als Passivmitglied isch agcho und wird prüeft.</p>
      <p>Du überchunsch i de nächste Täg ä Rächnig für de Passivmitgliedsbytrag (CHF 40.–).</p>
      <p>Bi Frage erreichsch eus under <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
    name: 'Name', team: 'Team', fee: 'Bytragskategorie', dob: 'Geburtsdatum',
    email: 'E-Mail', phone: 'Telefon', address: 'Adrässe', nationality: 'Nationalität',
    gender: 'Gschlächt', licence: 'Lizenz', refLevel: 'Schiedsrichter-Stuefe', ref: 'Referenz',
    adminTitle: 'Neui Aamäldig',
    adminCta: 'Im Admin prüefe',
    adminSubject: (vorname, nachname, type) => `[KSCW] Neui Aamäldig: ${vorname} ${nachname} (${type})`,
    adminType: 'Typ', adminAhv: 'AHV', adminKantonsschule: 'Kantonsschuel', adminBemerkungen: 'Bemerkige',
    adminNextSteps: 'Nächsti Schritt:',
    adminStep1: 'Date im Admin-Bereich prüefe und ev. bearbeite',
    adminStep2: 'Aamäldig bestätige oder abläne',
    adminStep3: 'Noch dr Bestätigig wird automatisch ä CSV-Datei gmacht',
  },
  en: {
    greeting: name => `Hello ${name},`,
    vbTitle: 'Welcome to KSC Wiedikon!',
    vbSubtitle: 'Your volleyball registration has been received',
    vbSubject: 'Welcome to KSC Wiedikon — Volleyball',
    vbFooter: 'Best regards — KSC Wiedikon Volleyball',
    vbFeeHeader: 'Membership Fees',
    vbBody: `<p>Please note that the licensing process takes at least one week after payment of the membership fee.</p>
      <p>You will receive an invoice from us in the next few days (or in August, the main billing period). Your licence will only be ordered once the fee has been received by KSCW — so please pay as soon as possible.</p>
      <p>You also need to create a login at <a href="https://volleymanager.volleyball.ch/login" style="color:#FFC832">volleymanager.volleyball.ch</a> if you don't have one yet.</p>
      <p>For questions about the club, your team or the licensing process, your coach or we are happy to help.</p>`,
    bbTitle: 'Registration received',
    bbSubtitle: 'KSC Wiedikon Basketball',
    bbSubject: 'Registration received — KSC Wiedikon Basketball',
    bbFooter: 'KSC Wiedikon Basketball',
    bbBody: `<p>Your registration will be reviewed by our admin team. You will be notified once it has been approved.</p>
      <p><strong style="color:#e2e8f0">Next steps:</strong></p>
      <ul style="padding-left:20px;margin:8px 0">
        <li>Make sure you have uploaded your ID copy (front and back)</li>
        <li>The licence application will be prepared by the admin</li>
        <li>Processing usually takes a few business days</li>
      </ul>
      <p>For questions, contact your coach or <a href="mailto:kontakt@kscw.ch" style="color:#F97316">kontakt@kscw.ch</a>.</p>`,
    passiveTitle: 'Passive Membership',
    passiveSubtitle: 'Registration received',
    passiveSubject: 'Passive Membership — KSC Wiedikon',
    passiveBody: `<p>Your registration as a passive member has been received and will be reviewed.</p>
      <p>You will receive an invoice for the passive membership fee (CHF 40.–) in the next few days.</p>
      <p>For questions, reach us at <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
    name: 'Name', team: 'Team', fee: 'Fee Category', dob: 'Date of Birth',
    email: 'Email', phone: 'Phone', address: 'Address', nationality: 'Nationality',
    gender: 'Sex', licence: 'Licence', refLevel: 'Referee Level', ref: 'Reference',
    adminTitle: 'New Registration',
    adminCta: 'Review in admin',
    adminSubject: (vorname, nachname, type) => `[KSCW] New registration: ${vorname} ${nachname} (${type})`,
    adminType: 'Type', adminAhv: 'AHV', adminKantonsschule: 'Cantonal School', adminBemerkungen: 'Notes',
    adminNextSteps: 'Next steps:',
    adminStep1: 'Review the data in the admin area and edit if needed',
    adminStep2: 'Approve or reject the registration',
    adminStep3: 'After approval, a CSV file is automatically generated',
  },
  fr: {
    greeting: name => `Salut ${name},`,
    vbTitle: 'Bienvenue au KSC Wiedikon !',
    vbSubtitle: 'Ton inscription en volleyball a été reçue',
    vbSubject: 'Bienvenue au KSC Wiedikon — Volleyball',
    vbFooter: 'Salutations sportives — KSC Wiedikon Volleyball',
    vbFeeHeader: 'Cotisations',
    vbBody: `<p>Note que la procédure de licence prend au minimum une semaine à partir du paiement de la cotisation.</p>
      <p>Tu recevras une facture de notre part dans les prochains jours (ou en août, la principale période de facturation). Ta licence ne sera commandée qu'une fois la cotisation reçue par le KSCW — donc paie aussi vite que possible.</p>
      <p>Tu dois en plus te créer un compte sur <a href="https://volleymanager.volleyball.ch/login" style="color:#FFC832">volleymanager.volleyball.ch</a> si tu n'en as pas encore.</p>
      <p>Pour toute question sur le club, ton équipe ou la procédure de licence, ton coach ou nous-mêmes te répondrons volontiers.</p>`,
    bbTitle: 'Inscription reçue',
    bbSubtitle: 'KSC Wiedikon Basketball',
    bbSubject: 'Inscription reçue — KSC Wiedikon Basketball',
    bbFooter: 'KSC Wiedikon Basketball',
    bbBody: `<p>Ta candidature sera examinée par notre équipe d'administration. Tu seras notifié·e dès qu'elle sera approuvée.</p>
      <p><strong style="color:#e2e8f0">Prochaines étapes :</strong></p>
      <ul style="padding-left:20px;margin:8px 0">
        <li>Assure-toi d'avoir téléchargé la copie de ta pièce d'identité (recto et verso)</li>
        <li>La demande de licence sera préparée par l'administrateur</li>
        <li>Le traitement prend généralement quelques jours ouvrables</li>
      </ul>
      <p>Pour toute question, contacte ton coach ou <a href="mailto:kontakt@kscw.ch" style="color:#F97316">kontakt@kscw.ch</a>.</p>`,
    passiveTitle: 'Membre passif·ve',
    passiveSubtitle: 'Inscription reçue',
    passiveSubject: 'Membre passif·ve — KSC Wiedikon',
    passiveBody: `<p>Ton inscription comme membre passif·ve a été reçue et sera examinée.</p>
      <p>Tu recevras dans les prochains jours une facture pour la cotisation de membre passif·ve (CHF 40.–).</p>
      <p>Pour toute question, écris-nous à <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
    name: 'Nom', team: 'Équipe', fee: 'Catégorie de cotisation', dob: 'Date de naissance',
    email: 'E-mail', phone: 'Téléphone', address: 'Adresse', nationality: 'Nationalité',
    gender: 'Sexe', licence: 'Licence', refLevel: "Niveau d'arbitrage", ref: 'Référence',
    adminTitle: 'Nouvelle inscription',
    adminCta: "Vérifier dans l'admin",
    adminSubject: (vorname, nachname, type) => `[KSCW] Nouvelle inscription : ${vorname} ${nachname} (${type})`,
    adminType: 'Type', adminAhv: 'AVS', adminKantonsschule: 'École cantonale', adminBemerkungen: 'Remarques',
    adminNextSteps: 'Prochaines étapes :',
    adminStep1: "Vérifier les données dans l'espace admin et les modifier si nécessaire",
    adminStep2: "Approuver ou refuser l'inscription",
    adminStep3: 'Après approbation, un fichier CSV est généré automatiquement',
  },
  it: {
    greeting: name => `Ciao ${name},`,
    vbTitle: 'Benvenuto al KSC Wiedikon!',
    vbSubtitle: 'La tua iscrizione al volleyball è stata ricevuta',
    vbSubject: 'Benvenuto al KSC Wiedikon — Volleyball',
    vbFooter: 'Saluti sportivi — KSC Wiedikon Volleyball',
    vbFeeHeader: 'Quote associative',
    vbBody: `<p>Tieni presente che il processo di licenza richiede almeno una settimana a partire dal pagamento della quota associativa.</p>
      <p>Riceverai una fattura da noi nei prossimi giorni (o in agosto, il principale periodo di fatturazione). La tua licenza verrà ordinata solo dopo che la quota sarà stata ricevuta dal KSCW — quindi paga il prima possibile.</p>
      <p>Devi inoltre creare un account su <a href="https://volleymanager.volleyball.ch/login" style="color:#FFC832">volleymanager.volleyball.ch</a> se non ne hai già uno.</p>
      <p>Per domande sul club, sulla tua squadra o sul processo di licenza, il tuo coach o noi stessi ti risponderemo volentieri.</p>`,
    bbTitle: 'Iscrizione ricevuta',
    bbSubtitle: 'KSC Wiedikon Basketball',
    bbSubject: 'Iscrizione ricevuta — KSC Wiedikon Basketball',
    bbFooter: 'KSC Wiedikon Basketball',
    bbBody: `<p>La tua iscrizione sarà esaminata dal nostro team di amministrazione. Riceverai una notifica non appena sarà approvata.</p>
      <p><strong style="color:#e2e8f0">Prossimi passi:</strong></p>
      <ul style="padding-left:20px;margin:8px 0">
        <li>Assicurati di aver caricato la copia del tuo documento d'identità (fronte e retro)</li>
        <li>La richiesta di licenza sarà preparata dall'amministratore</li>
        <li>L'elaborazione richiede di solito alcuni giorni lavorativi</li>
      </ul>
      <p>Per domande, contatta il tuo coach o <a href="mailto:kontakt@kscw.ch" style="color:#F97316">kontakt@kscw.ch</a>.</p>`,
    passiveTitle: 'Socio passivo',
    passiveSubtitle: 'Iscrizione ricevuta',
    passiveSubject: 'Socio passivo — KSC Wiedikon',
    passiveBody: `<p>La tua iscrizione come socio passivo è stata ricevuta e sarà esaminata.</p>
      <p>Riceverai nei prossimi giorni una fattura per la quota di socio passivo (CHF 40.–).</p>
      <p>Per domande scrivici a <a href="mailto:kontakt@kscw.ch" style="color:#4A55A2">kontakt@kscw.ch</a>.</p>`,
    name: 'Nome', team: 'Squadra', fee: 'Categoria quota', dob: 'Data di nascita',
    email: 'E-mail', phone: 'Telefono', address: 'Indirizzo', nationality: 'Nazionalità',
    gender: 'Sesso', licence: 'Licenza', refLevel: 'Livello arbitrale', ref: 'Riferimento',
    adminTitle: 'Nuova iscrizione',
    adminCta: "Verifica nell'admin",
    adminSubject: (vorname, nachname, type) => `[KSCW] Nuova iscrizione: ${vorname} ${nachname} (${type})`,
    adminType: 'Tipo', adminAhv: 'AVS', adminKantonsschule: 'Scuola cantonale', adminBemerkungen: 'Note',
    adminNextSteps: 'Prossimi passi:',
    adminStep1: "Verifica i dati nell'area admin e modificali se necessario",
    adminStep2: "Approva o rifiuta l'iscrizione",
    adminStep3: "Dopo l'approvazione, viene generato automaticamente un file CSV",
  },
}

const REG_LOCALES = ['de', 'gsw', 'en', 'fr', 'it']
function t(locale) { return T[locale] || T.de }

// The public website (the nachreichen page lives there, not in the member app).
const KSCW_WEBSITE_URL = process.env.KSCW_WEBSITE_URL || 'https://kscw.ch'

// Human names for the registration document COLUMNS, per locale.
// ⚠ Mirrors the LABELS map in kscw-website `public/js/anmeldung-dokumente.js` —
// the family reads these names in the email and then has to recognise the same
// upload slots on that page. Change both together or the two disagree.
// "Player's Self Declaration" and "Acknowledgment of National Team Restriction"
// are the official Swiss Basketball form titles and stay English everywhere.
const DOC_LABELS = {
  de: {
    id_upload_front: 'ID / Pass — Vorderseite',
    id_upload_back: 'ID / Pass — Rückseite',
    bb_doc_lizenz: 'Lizenzantrag (unterschrieben)',
    bb_doc_freibrief: 'Freibrief (unterschrieben)',
    bb_doc_selfdecl: "Player's Self Declaration",
    bb_doc_natdecl: 'Acknowledgment of National Team Restriction',
    bb_doc_u18parents: 'Einverständnis der Eltern (U18)',
    bb_doc_schoolcert: 'Schulbestätigung (optional)',
  },
  en: {
    id_upload_front: 'ID / passport — front',
    id_upload_back: 'ID / passport — back',
    bb_doc_lizenz: 'Licence application (signed)',
    bb_doc_freibrief: 'Release letter / Freibrief (signed)',
    bb_doc_selfdecl: "Player's Self Declaration",
    bb_doc_natdecl: 'Acknowledgment of National Team Restriction',
    bb_doc_u18parents: 'Parental consent (U18)',
    bb_doc_schoolcert: 'School enrolment certificate (optional)',
  },
  fr: {
    id_upload_front: "Carte d'identité / passeport — recto",
    id_upload_back: "Carte d'identité / passeport — verso",
    bb_doc_lizenz: 'Demande de licence (signée)',
    bb_doc_freibrief: 'Lettre de sortie / Freibrief (signée)',
    bb_doc_selfdecl: "Player's Self Declaration",
    bb_doc_natdecl: 'Acknowledgment of National Team Restriction',
    bb_doc_u18parents: 'Autorisation parentale (U18)',
    bb_doc_schoolcert: 'Attestation de scolarité (facultative)',
  },
  it: {
    id_upload_front: "Carta d'identità / passaporto — fronte",
    id_upload_back: "Carta d'identità / passaporto — retro",
    bb_doc_lizenz: 'Richiesta di licenza (firmata)',
    bb_doc_freibrief: 'Lettera di svincolo / Freibrief (firmata)',
    bb_doc_selfdecl: "Player's Self Declaration",
    bb_doc_natdecl: 'Acknowledgment of National Team Restriction',
    bb_doc_u18parents: 'Consenso dei genitori (U18)',
    bb_doc_schoolcert: 'Certificato di iscrizione scolastica (facoltativo)',
  },
}
DOC_LABELS.gsw = DOC_LABELS.de

// Copy for the staff-triggered "please (re-)upload your documents" email.
//
// These are DEFAULTS, not the final word: /admin/email-templates stores an
// editable row per locale under the key `registration_docs_request`, and each
// field falls back to the value here when the row is missing or the box was left
// empty (email-templates.js → mergeTemplate). Editing text must never be able to
// break a send, so the compiled-in copy always remains reachable.
//
// Deliberately says the club lost the files rather than implying the family
// failed to send them — for the 2026-07 cohort that is simply what happened.
//
// Placeholders: {{name}} {{documents}} {{reference}} {{email}} {{link}}.
// {{documents}} expands to a <ul> of the missing document names and is REQUIRED
// in body_html (the write hook rejects a body without it).
// The editable-template key these defaults back. Must match TEMPLATE_KEYS in
// email-templates.js and the seeded rows in migration 287.
const DOCS_REQUEST_KEY = 'registration_docs_request'
const DOCS_SUBTITLE = 'KSC Wiedikon Basketball'
const DOCS_T = {
  de: {
    subject: 'Bitte Dokumente erneut hochladen — KSC Wiedikon Basketball',
    title: 'Dokumente fehlen',
    greeting: 'Hallo {{name}},',
    body_html: `<p>wegen eines technischen Fehlers auf unserer Seite sind die Dokumente zur Anmeldung von <strong style="color:#e2e8f0">{{name}}</strong> bei uns nicht lesbar angekommen. Das liegt nicht an dir — wir müssen dich leider trotzdem bitten, sie noch einmal hochzuladen.</p>
<p><strong style="color:#e2e8f0">Diese Dokumente fehlen uns noch:</strong></p>
{{documents}}
<p>Über den Button unten kommst du direkt auf die Upload-Seite. Referenz und E-Mail sind bereits ausgefüllt — du musst nur noch die Dateien auswählen (JPG, PNG oder PDF, max. 10 MB pro Datei).</p>
<p style="font-size:13px;color:#94a3b8">Referenz: {{reference}} · E-Mail: {{email}}</p>
<p>Die Anmeldung selbst bleibt gültig — es fehlen nur die Dokumente für die Lizenz bei Swiss Basketball. Bei Fragen antworte einfach auf diese E-Mail oder schreib an <a href="mailto:kontakt@kscw.ch" style="color:#F97316">kontakt@kscw.ch</a>.</p>`,
    cta_label: 'Dokumente hochladen',
    footer: 'Vielen Dank — KSC Wiedikon Basketball',
  },
  en: {
    subject: 'Please re-upload your documents — KSC Wiedikon Basketball',
    title: 'Documents missing',
    greeting: 'Hi {{name}},',
    body_html: `<p>because of a technical fault on our side, the documents for <strong style="color:#e2e8f0">{{name}}</strong>'s registration did not reach us in a readable state. This was not your mistake — but we do have to ask you to upload them once more.</p>
<p><strong style="color:#e2e8f0">These documents are still missing:</strong></p>
{{documents}}
<p>The button below takes you straight to the upload page. Your reference and email are already filled in — you only need to pick the files (JPG, PNG or PDF, max. 10 MB each).</p>
<p style="font-size:13px;color:#94a3b8">Reference: {{reference}} · Email: {{email}}</p>
<p>The registration itself stays valid — only the documents for the Swiss Basketball licence are missing. If anything is unclear, just reply to this email or write to <a href="mailto:kontakt@kscw.ch" style="color:#F97316">kontakt@kscw.ch</a>.</p>`,
    cta_label: 'Upload documents',
    footer: 'Thank you — KSC Wiedikon Basketball',
  },
  fr: {
    subject: 'Merci de téléverser à nouveau tes documents — KSC Wiedikon Basketball',
    title: 'Documents manquants',
    greeting: 'Salut {{name}},',
    body_html: `<p>en raison d'une erreur technique de notre côté, les documents de l'inscription de <strong style="color:#e2e8f0">{{name}}</strong> ne nous sont pas parvenus dans un état lisible. Ce n'est pas de ta faute — nous devons malgré tout te demander de les téléverser une nouvelle fois.</p>
<p><strong style="color:#e2e8f0">Ces documents nous manquent encore :</strong></p>
{{documents}}
<p>Le bouton ci-dessous te mène directement à la page de téléversement. Ta référence et ton e-mail sont déjà remplis — il te suffit de choisir les fichiers (JPG, PNG ou PDF, 10 Mo max. par fichier).</p>
<p style="font-size:13px;color:#94a3b8">Référence : {{reference}} · E-mail : {{email}}</p>
<p>L'inscription elle-même reste valable — seuls les documents pour la licence Swiss Basketball manquent. Pour toute question, réponds simplement à cet e-mail ou écris à <a href="mailto:kontakt@kscw.ch" style="color:#F97316">kontakt@kscw.ch</a>.</p>`,
    cta_label: 'Téléverser les documents',
    footer: 'Merci beaucoup — KSC Wiedikon Basketball',
  },
  it: {
    subject: 'Per favore ricarica i tuoi documenti — KSC Wiedikon Basketball',
    title: 'Documenti mancanti',
    greeting: 'Ciao {{name}},',
    body_html: `<p>a causa di un errore tecnico da parte nostra, i documenti dell'iscrizione di <strong style="color:#e2e8f0">{{name}}</strong> non ci sono arrivati in forma leggibile. Non è colpa tua — dobbiamo comunque chiederti di caricarli un'altra volta.</p>
<p><strong style="color:#e2e8f0">Ci mancano ancora questi documenti:</strong></p>
{{documents}}
<p>Il pulsante qui sotto ti porta direttamente alla pagina di caricamento. Riferimento ed e-mail sono già compilati — devi solo scegliere i file (JPG, PNG o PDF, max. 10 MB ciascuno).</p>
<p style="font-size:13px;color:#94a3b8">Riferimento: {{reference}} · E-mail: {{email}}</p>
<p>L'iscrizione resta valida — mancano solo i documenti per la licenza Swiss Basketball. Per domande rispondi a questa e-mail o scrivi a <a href="mailto:kontakt@kscw.ch" style="color:#F97316">kontakt@kscw.ch</a>.</p>`,
    cta_label: 'Carica i documenti',
    footer: 'Grazie mille — KSC Wiedikon Basketball',
  },
}
DOCS_T.gsw = DOCS_T.de

// Capitalize the first letter for display. The registration form stores
// free-text gender ("männlich") and the membership_type enum ("basketball")
// in lowercase — both should render capitalized in emails ("Männlich",
// "Basketball"). Returns the input unchanged when falsy/non-string.
function capFirst(s) {
  if (!s || typeof s !== 'string') return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function buildSummaryCard(reg, locale) {
  const l = t(locale)
  const dob = reg.geburtsdatum ? formatDateCH(reg.geburtsdatum) : '-'
  return buildInfoCard([
    { label: l.name, value: `${reg.vorname} ${reg.nachname}`, halfWidth: true },
    { label: l.team, value: reg.team || '-', halfWidth: true },
    { label: l.fee, value: reg.beitragskategorie || '-', halfWidth: true },
    { label: l.dob, value: dob, halfWidth: true },
    { label: l.email, value: reg.email },
    { label: l.phone, value: reg.telefon_mobil || '-' },
    { label: l.address, value: `${reg.adresse || ''}, ${reg.plz || ''} ${reg.ort || ''}` },
    { label: l.nationality, value: reg.nationalitaet || '-', halfWidth: true },
    { label: l.gender, value: capFirst(reg.geschlecht) || '-', halfWidth: true },
    ...(reg.lizenz ? [{ label: l.licence, value: reg.lizenz }] : []),
    ...(reg.schiedsrichter_stufe ? [{ label: l.refLevel, value: reg.schiedsrichter_stufe }] : []),
    { label: l.ref, value: reg.reference_number },
  ])
}

function buildVolleyballEmail(reg, locale) {
  const l = t(locale)
  const summary = buildSummaryCard(reg, locale)

  const feeLines = VB_FEE_LINES[locale] || VB_FEE_LINES.de
  const feeTable = `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;border:1px solid #334155;border-radius:8px;overflow:hidden;margin:12px 0">
  <tr><td style="padding:16px 20px">
    <div style="font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.5px;margin-bottom:8px;font-weight:700">${l.vbFeeHeader}</div>
    <div style="font-size:13px;color:#e2e8f0;line-height:1.8">${feeLines}</div>
  </td></tr>
</table>`

  const body = summary + feeTable + `
<div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-top:12px;text-align:justify">
  ${l.vbBody}
</div>`

  return buildEmailLayout(body, {
    title: l.vbTitle,
    subtitle: l.vbSubtitle,
    sport: 'volleyball',
    greeting: l.greeting(reg.vorname),
    footerExtra: l.vbFooter,
  })
}

function buildBasketballEmail(reg, locale) {
  const l = t(locale)
  const summary = buildSummaryCard(reg, locale)

  const body = summary + `
<div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-top:12px;text-align:justify">
  ${l.bbBody}
</div>`

  return buildEmailLayout(body, {
    title: l.bbTitle,
    subtitle: l.bbSubtitle,
    sport: 'basketball',
    greeting: l.greeting(reg.vorname),
    footerExtra: l.bbFooter,
  })
}

function buildPassiveEmail(reg, locale) {
  const l = t(locale)
  const summary = buildInfoCard([
    { label: l.name, value: `${reg.vorname} ${reg.nachname}` },
    { label: l.email, value: reg.email },
    { label: l.phone, value: reg.telefon_mobil || '-' },
    ...(reg.lizenz ? [{ label: l.licence, value: reg.lizenz }] : []),
    ...(reg.schiedsrichter_stufe ? [{ label: l.refLevel, value: reg.schiedsrichter_stufe }] : []),
    { label: l.ref, value: reg.reference_number },
  ])

  const body = summary + `
<div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-top:12px;text-align:justify">
  ${l.passiveBody}
</div>`

  return buildEmailLayout(body, {
    title: l.passiveTitle,
    subtitle: l.passiveSubtitle,
    greeting: l.greeting(reg.vorname),
    footerExtra: 'KSC Wiedikon',
  })
}

// ── Admin notification email ────────────────────────────────────

function buildAdminNotificationEmail(reg, locale = 'de') {
  const l = t(locale)
  const dob = reg.geburtsdatum ? formatDateCH(reg.geburtsdatum) : '-'
  const sport = reg.membership_type === 'volleyball' ? 'volleyball' : reg.membership_type === 'basketball' ? 'basketball' : null

  const summary = buildInfoCard([
    { label: l.name, value: `${reg.vorname} ${reg.nachname}`, halfWidth: true },
    { label: l.adminType, value: capFirst(reg.membership_type), halfWidth: true },
    { label: l.team, value: reg.team || '-', halfWidth: true },
    { label: l.fee, value: reg.beitragskategorie || '-', halfWidth: true },
    { label: l.email, value: reg.email, halfWidth: true },
    { label: l.phone, value: reg.telefon_mobil || '-', halfWidth: true },
    { label: l.address, value: `${reg.adresse || ''}, ${reg.plz || ''} ${reg.ort || ''}` },
    { label: l.dob, value: dob, halfWidth: true },
    { label: l.nationality, value: reg.nationalitaet || '-', halfWidth: true },
    { label: l.adminAhv, value: reg.ahv_nummer || '-', halfWidth: true },
    { label: l.adminKantonsschule, value: reg.kantonsschule || '-', halfWidth: true },
    ...(reg.lizenz ? [{ label: l.licence, value: reg.lizenz }] : []),
    ...(reg.schiedsrichter_stufe ? [{ label: l.refLevel, value: reg.schiedsrichter_stufe }] : []),
    { label: l.ref, value: reg.reference_number },
  ])

  const instructions = `
<div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-top:12px">
  <p><strong style="color:#e2e8f0">${l.adminNextSteps}</strong></p>
  <ol style="padding-left:20px;margin:8px 0">
    <li>${l.adminStep1}</li>
    <li>${l.adminStep2}</li>
    <li>${l.adminStep3}</li>
  </ol>
</div>`

  const body = summary +
    (reg.bemerkungen ? `<div style="font-size:13px;color:#94a3b8;margin-top:12px"><strong style="color:#e2e8f0">${l.adminBemerkungen}:</strong><br>${escHtml(reg.bemerkungen)}</div>` : '') +
    instructions

  return buildEmailLayout(body, {
    title: l.adminTitle,
    subtitle: `${reg.vorname} ${reg.nachname} — ${capFirst(reg.membership_type)}`,
    sport,
    ctaUrl: 'https://wiedisync.kscw.ch/admin/anmeldungen',
    ctaLabel: l.adminCta,
  })
}

// ── Endpoint ────────────────────────────────────────────────────

// directus_files primary keys are UUIDs — reject anything else so the public
// file-attach route can't point a registration's file columns at an arbitrary
// string value.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Private quarantine folder for registration documents (migration 169; same
// UUID on every environment). Files uploaded via /registration/upload are born
// in here — never folder-less, never anonymous-readable via /assets.
const REGISTRATION_FILES_FOLDER = 'a0000167-0000-4000-8000-000000000001'
const UPLOAD_ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'])
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024
// The registration document columns a member is allowed to view for their own
// (post-approval) registration. Mirrors REGISTRATION_FILE_COLS in kscw-hooks.
const SELF_DOC_FIELDS = [
  'id_upload_front', 'id_upload_back',
  'bb_doc_lizenz', 'bb_doc_freibrief', 'bb_doc_selfdecl',
  'bb_doc_natdecl', 'bb_doc_u18parents', 'bb_doc_schoolcert',
]

export function registerRegistration(router, { database, logger, services, getSchema }) {
  const log = logger.child({ endpoint: 'registration' })

  // Render the document-request email for one registration. Shared by the send
  // route and the admin preview so the page can never show copy that differs from
  // what the family would actually receive.
  const buildDocsRequestEmail = async (reg, locale, missing, overrides = null) => {
    const fallback = DOCS_T[locale] || DOCS_T.de
    const stored = await loadTemplate(database, DOCS_REQUEST_KEY, locale, log)
    // Precedence: unsaved editor overrides → stored row → compiled-in default,
    // each resolved per field so a blank box anywhere falls through rather than
    // producing an empty section.
    const merged = mergeTemplate(fallback, mergeTemplate(stored || {}, overrides))

    const link = `${KSCW_WEBSITE_URL}/weiteres/anmeldung-dokumente?ref=${encodeURIComponent(reg.reference_number)}&email=${encodeURIComponent(reg.email)}`
    const listHtml = missing
      .map((f) => `<li style="margin:4px 0">${escHtml(DOC_LABELS[locale]?.[f] || DOC_LABELS.de[f] || f)}</li>`)
      .join('')

    // ⚠ Two substitution passes, because the two destinations have opposite
    // escaping contracts. `body_html` is injected into the layout RAW, so its
    // values must arrive already escaped. Every other slot (subject, title,
    // greeting, cta, footer) is either plain text or run through escHtml by
    // buildEmailLayout itself — pre-escaping those would render a family called
    // "Ruiz &amp; Sons" literally, with the entity visible.
    const rawVars = {
      name: reg.vorname || '',
      documents: '', // list-only; rejected by validateTemplate outside the body
      reference: reg.reference_number || '',
      email: reg.email || '',
      link,
    }
    const htmlVars = {
      name: escHtml(rawVars.name),
      documents: `<ul style="padding-left:20px;margin:8px 0;color:#e2e8f0">${listHtml}</ul>`,
      reference: escHtml(rawVars.reference),
      email: escHtml(rawVars.email),
      link: escHtml(link),
    }
    const chrome = renderTemplate(
      { subject: merged.subject, title: merged.title, greeting: merged.greeting, cta_label: merged.cta_label, footer: merged.footer },
      rawVars,
    )
    const { body_html: body } = renderTemplate({ body_html: merged.body_html }, htmlVars)

    return {
      subject: chrome.subject,
      html: buildEmailLayout(sanitizeTemplateHtml(body), {
        sport: reg.membership_type,
        title: chrome.title,
        subtitle: DOCS_SUBTITLE,
        greeting: chrome.greeting,
        ctaUrl: link,
        ctaLabel: chrome.cta_label,
        footerExtra: chrome.footer,
      }),
    }
  }

  // ── Member self-view of their own registration documents ────────────────────
  // After approval the registration row is kept and stamped with `member`, so a
  // logged-in member can see the ID / basketball docs they uploaded. Read-only,
  // strictly scoped to the caller's own registration (via members.user →
  // registrations.member); the private folder + file id both come from the
  // caller's own row, so this never widens access to anyone else's files.
  const findSelfRegistration = async (userId) => {
    if (!userId) return null
    const self = await database('members').where('user', userId).select('id').first()
    if (!self) return null
    // Most recent registration linked to this member.
    return database('registrations').where('member', self.id).orderBy('id', 'desc').first()
  }

  // GET /kscw/registration/my-docs — list the caller's own uploaded documents.
  //
  // ⚠ DELIBERATELY IGNORES "View as member". Impersonation is client-side (the
  // request still carries the superadmin's session), and /finance/my-invoices
  // was given an explicit ?member= so support can answer "does this member owe?".
  // Do NOT copy that here: these are identity documents (ID copies, foreign-player
  // declarations). A read-only viewing feature must not become a way to pull
  // another member's papers. Same for the :field streaming route below.
  router.get('/registration/my-docs', async (req, res) => {
    try {
      const userId = req.accountability?.user
      if (!userId) return res.status(401).json({ error: 'Unauthorized' })
      const reg = await findSelfRegistration(userId)
      if (!reg) return res.json({ reference_number: null, status: null, docs: [] })
      const ids = SELF_DOC_FIELDS.map((f) => reg[f]).filter(Boolean)
      const files = ids.length
        ? await database('directus_files').whereIn('id', ids).select('id', 'filename_download', 'type', 'filesize')
        : []
      const byId = new Map(files.map((f) => [String(f.id), f]))
      const docs = SELF_DOC_FIELDS
        .filter((f) => reg[f] && byId.has(String(reg[f])))
        .map((f) => {
          const file = byId.get(String(reg[f]))
          return { field: f, filename: file.filename_download || f, type: file.type || null, size: file.filesize ?? null }
        })
      return res.json({ reference_number: reg.reference_number || null, status: reg.status || null, docs })
    } catch (err) {
      log.error({ msg: `registration/my-docs: ${err.message}`, endpoint: 'registration/my-docs', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /kscw/registration/my-docs/:field — stream one of the caller's own docs.
  router.get('/registration/my-docs/:field', async (req, res) => {
    try {
      const userId = req.accountability?.user
      if (!userId) return res.status(401).json({ error: 'Unauthorized' })
      const field = String(req.params.field || '')
      if (!SELF_DOC_FIELDS.includes(field)) return res.status(400).json({ error: 'Invalid document' })
      const reg = await findSelfRegistration(userId)
      const fileId = reg?.[field]
      if (!fileId) return res.status(404).json({ error: 'Not found' })
      // The id came from the caller's own registration; also pin the private
      // folder so a mismatched/repointed id can't reach an unrelated file.
      const row = await database('directus_files')
        .where({ id: fileId, folder: REGISTRATION_FILES_FOLDER })
        .first('id', 'filename_disk', 'filename_download', 'type')
      if (!row || !row.filename_disk) return res.status(404).json({ error: 'Not found' })
      // Read through the storage abstraction, not the local disk: it resolves the driver
      // from directus_files.storage per row, so this keeps working when uploads move to R2.
      await streamManagedFile(
        row.id,
        { services, getSchema, database },
        res,
        { filename: row.filename_download || field, type: row.type },
      )
      return
    } catch (err) {
      if (err?.code === 'ENOENT') return res.status(404).json({ error: 'Not found' })
      log.error({ msg: `registration/my-docs/:field: ${err.message}`, endpoint: 'registration/my-docs', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // Per-IP throttle for the public /registration/:id/files route. The route
  // authorizes writes by matching a short (~4-digit) reference_number, so without
  // a limiter an attacker could brute-force references and overwrite a victim's
  // uploaded ID/document file pointers (IDOR). 10 attempts / 10 min per IP, with
  // a tighter lockout once reference mismatches (the brute-force signal) pile up.
  const fileAttachIp = new Map() // ip → { count, resetAt, mismatches }

  // Per-IP throttle for the public /registration create route. Turnstile already
  // gates it, but each accepted submission fans out several staff/owner
  // notification emails — a solved or misconfigured Turnstile shouldn't turn that
  // into an email amplifier. Defense-in-depth: 5 submissions / 10 min per IP.
  const registerIp = new Map() // ip → { count, resetAt }

  // POST /kscw/registration — create new registration
  router.post('/registration', async (req, res) => {
    try {
      const body = req.body
      if (!body || !body.vorname || !body.nachname || !body.email || !body.membership_type) {
        return res.status(400).json({ error: 'vorname, nachname, email, membership_type required' })
      }

      // ── Contact-data guards (2026-07-07) — reject un-normalizable values at the
      // door and store the CANONICAL form (normalize.js), so both databases stay
      // standardized (INFRA.md → "Contact-data normalization rule"). Messages are
      // localized: they reach real users via the public form (which mirrors these
      // checks client-side — server = bypass/stale-cache backstop).
      const isEn = body.locale === 'en'
      const emailNorm = normalizeEmail(body.email)
      if (!emailNorm.ok || !emailNorm.value) {
        return res.status(400).json({ error: 'Invalid email format' })
      }
      const phoneNorm = normalizePhone(body.telefon_mobil)
      if (!phoneNorm.ok) {
        return res.status(400).json({
          error: isEn
            ? 'Please check the phone number — it does not look like a valid number.'
            : 'Bitte überprüfe die Telefonnummer — sie scheint ungültig zu sein.',
          code: 'invalid_phone',
        })
      }
      const ahvNorm = normalizeAhv(body.ahv_nummer)
      if (!ahvNorm.ok) {
        return res.status(400).json({
          error: isEn
            ? 'Please check the AHV number (format 756.XXXX.XXXX.XX) — the check digit does not match.'
            : 'Bitte überprüfe die AHV-Nummer (Format 756.XXXX.XXXX.XX) — die Prüfziffer stimmt nicht.',
          code: 'invalid_ahv',
        })
      }
      // IBAN is REQUIRED (used to pay money back — reimbursements/expenses;
      // registrations.iban, migration 185). Mirrors the client's required check;
      // server = bypass/stale-cache backstop.
      const ibanNorm = normalizeIban(body.iban)
      if (!ibanNorm.ok) {
        return res.status(400).json({
          error: isEn
            ? 'Please check the IBAN — it is not a valid account number.'
            : 'Bitte überprüfe die IBAN — sie ist keine gültige Kontonummer.',
          code: 'invalid_iban',
        })
      }
      if (!ibanNorm.value) {
        return res.status(400).json({
          error: isEn
            ? 'Please enter your IBAN.'
            : 'Bitte gib deine IBAN an.',
          code: 'iban_required',
        })
      }

      const validTypes = ['volleyball', 'basketball', 'passive']
      if (!validTypes.includes(body.membership_type)) {
        return res.status(400).json({ error: 'Invalid membership_type' })
      }

      // A guest (funktion "Guest" on a VB/BB registration — see the signup form's
      // "Gast (Guest)" option) trains with a team but is not licensed to play
      // league games, so they skip the licence apparatus: no AHV requirement and
      // no basketball ID/licence-document uploads (user 2026-07-15). Mirrors the
      // lightweight guest gate in kscw-website registration-form.js.
      const isGuest = String(body.rolle || '').trim().toLowerCase() === 'guest'

      // AHV requiredness mirror (the form enforces it client-side): active VB
      // members under 23 and BB members under 25 need an AHV number for the
      // association licence. Server-side so a bypassed/stale form can't create
      // a licence-blocked registration.
      if (!isGuest && !ahvNorm.value && body.geburtsdatum && ['volleyball', 'basketball'].includes(body.membership_type)) {
        const dob = new Date(body.geburtsdatum)
        if (!Number.isNaN(dob.getTime())) {
          const now = new Date()
          let age = now.getFullYear() - dob.getFullYear()
          const m = now.getMonth() - dob.getMonth()
          if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--
          const limit = body.membership_type === 'volleyball' ? 23 : 25
          if (age < limit) {
            return res.status(400).json({
              error: isEn
                ? 'The AHV number is required for the licence at your age.'
                : 'Die AHV-Nummer ist für die Lizenz in deinem Alter erforderlich.',
              code: 'ahv_required',
            })
          }
        }
      }

      // Per-IP rate limit (defense-in-depth behind Turnstile — each submission
      // fans out several notification emails). cf-connecting-ip is the real
      // client IP; the leftmost XFF value is attacker-spoofable behind CF.
      const xff = req.headers['x-forwarded-for']
      const ip = req.headers['cf-connecting-ip']
        || (typeof xff === 'string' ? xff.split(',')[0].trim() : '')
        || req.ip || 'unknown'
      const now = Date.now()
      const regEntry = registerIp.get(ip)
      if (regEntry && now < regEntry.resetAt) {
        if (regEntry.count >= 5) return res.status(429).json({ error: 'Too many requests. Please try again later.' })
        regEntry.count++
      } else {
        registerIp.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 })
      }
      if (registerIp.size > 1000) {
        for (const [k, v] of registerIp) { if (now > v.resetAt) registerIp.delete(k) }
      }

      if (!body.turnstile_token || !(await verifyTurnstile(body.turnstile_token))) {
        return res.status(400).json({ error: 'Captcha verification failed' })
      }

      // ── Already a member? (2026-08-19) ────────────────────────────────────
      // Until now this route had NO identity check: an existing member could
      // file a second registration for themselves, and five of the first 36
      // prod rows did exactly that (REG-2026-7074 arrived with the *same*
      // email as member #195). Blocking is limited to an ACTIVE member whose
      // email AND first name AND last name all match — never email alone,
      // because families legitimately share one mailbox (members.email has no
      // unique index for that reason). A FORMER member rejoining, or a softer
      // name/birthdate resemblance, is deliberately let through and flagged
      // for /admin/anmeldungen instead: blocking a returning ehemalige would
      // leave them no route back into the club.
      //
      // The website form runs the same check live (/registration/check-duplicate)
      // so nobody fills 40 fields first; this is the bypass/stale-cache backstop.
      //
      // ⚠ Deliberately placed AFTER the rate limit and Turnstile. The gate
      // answers "is this exact person an active member"; running it earlier
      // would turn the create route into an uncaptcha'd, unthrottled membership
      // oracle — strictly weaker than /registration/check-duplicate, which
      // carries its own per-IP limit for exactly that reason.
      const blocker = await findBlockingMember(database, { ...body, email: emailNorm.value })
      if (blocker) {
        log.warn({ msg: `Registration blocked — already an active member (#${blocker.id})`, email: emailNorm.value, memberId: blocker.id })
        return res.status(409).json({
          error: isEn
            ? 'You are already registered with KSC Wiedikon. Log in at wiedisync.kscw.ch, or write to admin@wiedisync.kscw.ch to change sport or team.'
            : 'Du bist bereits beim KSC Wiedikon angemeldet. Melde dich auf wiedisync.kscw.ch an, oder schreibe an admin@wiedisync.kscw.ch, um Sportart oder Team zu ändern.',
          code: 'already_member',
        })
      }

      // Server-side document enforcement (basketball): the registration is only
      // created once the required documents are already uploaded to /files and
      // their UUIDs arrive WITH the create payload — closes the create-before-
      // upload gap that stranded REG-2026-5041 doc-less (2026-07-04, Safari
      // upload failure after the row was committed). Required: ID front/back +
      // signed licence application; non-Swiss additionally the FIBA self
      // declaration + national team declaration (5 total). Mirrors the client
      // gate in kscw-website registration-form.js — same rule for every
      // basketball function, as on the form.
      const docId = (v) => (typeof v === 'string' && UUID_RE.test(v)) ? v : null
      const docs = {
        id_upload_front: docId(body.id_upload_front),
        id_upload_back: docId(body.id_upload_back),
        bb_doc_lizenz: docId(body.bb_doc_lizenz),
        bb_doc_freibrief: docId(body.bb_doc_freibrief),
        bb_doc_selfdecl: docId(body.bb_doc_selfdecl),
        bb_doc_natdecl: docId(body.bb_doc_natdecl),
        bb_doc_u18parents: docId(body.bb_doc_u18parents),
        bb_doc_schoolcert: docId(body.bb_doc_schoolcert),
      }
      const bbSituation = BB_SITUATIONS.includes(body.bb_situation) ? body.bb_situation : null
      // Only meaningful for a Swiss-club transfer, and only 'ja'/'nein' are stored
      // (migration 232 CHECKs the same set). Anything else — including the field
      // being absent on an older cached bundle — is NULL: unanswered, which keeps
      // the Freibrief required rather than silently waiving it.
      const bbRecentLicence = bbSituation === 'transfer_ch'
        && ['ja', 'nein'].includes(String(body.bb_recent_licence || '').toLowerCase())
        ? String(body.bb_recent_licence).toLowerCase()
        : null
      // Coded nationality (migration 223). `natCodes` is the full ordered list;
      // `primaryNatCode` keeps the legacy singular column populated so every
      // consumer that still reads one code (the doc gate's fallback, the admin
      // list) is unaffected. Fall back to whatever the body sends for forms
      // still on the pre-multi-select bundle.
      const natCodes = normalizeCountryCodes(body.nationalitaet_codes)
      const primaryNatCode = natCodes
        ? natCodes.split(',')[0]
        : ((body.nationalitaet_code || '').trim().toUpperCase().slice(0, 2) || null)
      const federationOfOrigin = normalizeFederation(body.federation_of_origin)
      if (vbFederationMissing(body.membership_type, isGuest, federationOfOrigin)) {
        const msg = isEn
          ? 'Please select your federation of origin — choose Switzerland if this is your first licence. If you cannot see this field, please reload the page.'
          : 'Bitte wähle deinen Herkunftsverband — wähle die Schweiz, falls dies deine erste Lizenz ist. Falls du dieses Feld nicht siehst, lade die Seite bitte neu.'
        return res.status(400).json({ error: msg, code: 'federation_required' })
      }
      if (body.membership_type === 'basketball' && !isGuest) {
        // A dual national holding a Swiss passport is Swiss for FIBA, so the
        // gate judges the list as a whole (fibaNatCode), not just the primary.
        const natCode = fibaNatCode(natCodes, body.nationalitaet_code)
        // Situation + nationality + age drive the required set (school certificate
        // is optional → never required). Mirrors the client gate.
        const required = bbRequiredDocs(bbSituation, natCode, body.geburtsdatum, bbRecentLicence)
        const missing = required.filter((k) => !docs[k])
        if (missing.length) {
          // Localized: this message reaches users on a STALE cached form JS
          // (pre-eager-upload, sends no doc ids) — tell them to reload so the
          // new bundle takes over.
          const msg = body.locale === 'en'
            ? 'Required documents missing. Please reload the page and try again.'
            : 'Erforderliche Dokumente fehlen. Bitte lade die Seite neu und versuche es erneut.'
          return res.status(400).json({ error: msg, code: 'docs_required', missing })
        }
      }
      // Provided doc ids must be REAL files that already live in the PRIVATE
      // registration folder — i.e. produced by /registration/upload. Without the
      // folder scope a caller could pass the UUID of any PUBLIC asset (team photo,
      // sponsor logo, harvested from /assets), and the quarantine hook would then
      // move that public file into the private folder (breaking the public read)
      // and the orphan sweep would eventually delete it. Anonymous data loss.
      const providedDocIds = [...new Set(Object.values(docs).filter(Boolean))]
      if (providedDocIds.length) {
        const found = await database('directus_files')
          .whereIn('id', providedDocIds)
          .where('folder', REGISTRATION_FILES_FOLDER)
          .count('id as n').first()
        if (Number(found?.n) !== providedDocIds.length) {
          return res.status(400).json({ error: 'Invalid document reference', code: 'docs_invalid' })
        }
      }

      const reference_number = generateRefNumber()

      const schema = await getSchema()
      const { ItemsService, MailService } = services
      const itemsService = new ItemsService('registrations', { schema, knex: database })

      const id = await itemsService.createOne({
        status: 'pending',
        membership_type: body.membership_type,
        anrede: body.anrede || null,
        // Title-case names + address so lazy all-lowercase entry ("janina vanha",
        // "rosengartenstrasse 33", "zürich") is stored — and shown in the
        // confirmation / admin emails and the /admin list — properly capitalized.
        vorname: titleCaseName(body.vorname),
        nachname: titleCaseName(body.nachname),
        email: emailNorm.value,
        telefon_mobil: phoneNorm.value,
        adresse: titleCaseName(body.adresse),
        plz: body.plz || null,
        ort: titleCaseName(body.ort),
        geburtsdatum: body.geburtsdatum || null,
        nationalitaet: body.nationalitaet || null,
        // Multi-nationality (migration 223): the ordered code list is the new
        // source of truth, the singular code stays as its FIRST entry — the
        // basketball document gate and the ClubDesk push both key off one code.
        nationalitaet_codes: natCodes,
        nationalitaet_code: primaryNatCode,
        federation_of_origin: federationOfOrigin,
        geschlecht: body.geschlecht || null,
        ahv_nummer: ahvNorm.value,
        iban: ibanNorm.value,
        team: Array.isArray(body.team) ? body.team.join(', ') : (body.team || null),
        beitragskategorie: body.beitragskategorie || null,
        kantonsschule: body.kantonsschule || null,
        rolle: body.rolle || null,
        lizenz: body.lizenz || null,
        schiedsrichter_stufe: body.schiedsrichter_stufe || null,
        bemerkungen: body.bemerkungen || null,
        locale: body.locale === 'en' ? 'en' : 'de',
        reference_number,
        submitted_at: new Date().toISOString(),
        // Licensing situation (new / Swiss-club transfer / from abroad / returner)
        // — drives the required document set on re-upload + admin review.
        bb_situation: bbSituation,
        // Decides whether the Freibrief is required — must be stored, or the
        // doc-status page and the approval gate would re-demand a document the
        // create route correctly waived.
        bb_recent_licence: bbRecentLicence,
        // Document file ids arrive with the create since the eager-upload form
        // (v3.3.0); the quarantine hook moves them to the private folder.
        ...docs,
      })

      const reg = await itemsService.readOne(id)

      // Send confirmation email to user (in the locale they used)
      const locale = body.locale === 'en' ? 'en' : 'de'
      const l = t(locale)
      const mail = new MailService({ schema, knex: database })
      try {
        let emailHtml
        let emailSubject
        if (body.membership_type === 'volleyball') {
          emailHtml = buildVolleyballEmail(reg, locale)
          emailSubject = l.vbSubject
        } else if (body.membership_type === 'basketball') {
          emailHtml = buildBasketballEmail(reg, locale)
          emailSubject = l.bbSubject
        } else {
          emailHtml = buildPassiveEmail(reg, locale)
          emailSubject = l.passiveSubject
        }

        await mail.send({
          to: reg.email,
          subject: emailSubject,
          html: emailHtml,
        })

        // Notify sport admins (resolved from DB) — one email per locale bucket
        // so each admin reads it in their own `members.language`. The OWNER_EMAIL
        // is a forwarding alias (kontakt@kscw.ch) without a member record, so
        // we used to CC it on whichever bucket happened to have people — that
        // pushed the German copy to anglophone admins via the alias. Instead,
        // send the OWNER_EMAIL its own copy in the registering user's locale
        // (matches the form they submitted, deterministic regardless of admin
        // composition). Real admins still get their bucketed locale.
        const adminEmails = await getSportAdminEmails(database, body.membership_type)
        const ownerLower = OWNER_EMAIL.toLowerCase()
        const adminTo = adminEmails.filter(e => e !== ownerLower)
        const adminBuckets = await bucketEmailsByLocale(database, adminTo)

        for (const loc of REG_LOCALES) {
          const tos = adminBuckets[loc]
          if (!tos.length) continue
          const lAdmin = T[loc] || T.de
          await mail.send({
            to: tos,
            subject: lAdmin.adminSubject(reg.vorname, reg.nachname, capFirst(reg.membership_type)),
            html: buildAdminNotificationEmail(reg, loc),
          })
        }

        // Owner alias: send a copy in the registering user's locale.
        // (If real admins are absent — e.g. a passive registration with no
        // sport admins — this also serves as the admin notification.)
        const ownerLAdmin = T[locale] || T.de
        await mail.send({
          to: [OWNER_EMAIL],
          subject: ownerLAdmin.adminSubject(reg.vorname, reg.nachname, capFirst(reg.membership_type)),
          html: buildAdminNotificationEmail(reg, locale),
        })
      } catch (emailErr) {
        log.warn({ msg: `Confirmation email failed: ${emailErr.message}`, id })
        // Don't fail the registration if email fails
      }

      log.info({ msg: 'Registration created', id, type: body.membership_type, ref: reference_number })
      res.json({ success: true, id, reference_number })
    } catch (err) {
      log.error({
        msg: `registration: ${err.message}`,
        endpoint: 'registration',
        method: req.method,
        stack: err.stack,
      })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/registration/:id/files — upload ID files
  // Frontend sends files as FormData after initial registration
  router.post('/registration/:id/files', async (req, res) => {
    try {
      const { id } = req.params
      if (!id) return res.status(400).json({ error: 'id required' })

      // Rate limit + brute-force lockout (reference_number is short, so this is
      // the real protection against IDOR overwrites — see fileAttachIp above).
      // cf-connecting-ip is the real client IP: CF appends the client to XFF, so
      // the leftmost XFF value is attacker-spoofable and would hand each spoofed
      // header a fresh bucket, defeating the limiter + lockout below.
      const xff = req.headers['x-forwarded-for']
      const ip = req.headers['cf-connecting-ip']
        || (typeof xff === 'string' ? xff.split(',')[0].trim() : '')
        || req.ip || 'unknown'
      const now = Date.now()
      const ipEntry = fileAttachIp.get(ip)
      if (ipEntry && now < ipEntry.resetAt) {
        if (ipEntry.count >= 10 || ipEntry.mismatches >= 5) {
          return res.status(429).json({ error: 'Too many requests' })
        }
        ipEntry.count++
      } else {
        fileAttachIp.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000, mismatches: 0 })
      }
      if (fileAttachIp.size > 1000) {
        for (const [k, v] of fileAttachIp) { if (now > v.resetAt) fileAttachIp.delete(k) }
      }

      const schema = await getSchema()
      const { ItemsService, FilesService } = services
      const itemsService = new ItemsService('registrations', { schema, knex: database })

      // Verify registration exists, is pending, and caller knows the reference number
      const { reference_number, id_upload_front, id_upload_back, bb_doc_lizenz, bb_doc_freibrief, bb_doc_selfdecl, bb_doc_natdecl, bb_doc_u18parents, bb_doc_schoolcert } = req.body
      if (!reference_number) {
        return res.status(400).json({ error: 'reference_number required' })
      }

      let reg
      try {
        reg = await itemsService.readOne(id)
      } catch {
        return res.status(404).json({ error: 'Registration not found' })
      }
      // 'approved' is allowed for the late document re-upload page (a stranded
      // registration may have been approved before its docs arrived — e.g.
      // REG-2026-5041); it requires the registration email as a second factor
      // on top of the reference number.
      if (!reg || !['pending', 'approved'].includes(reg.status)) {
        return res.status(404).json({ error: 'Registration not found' })
      }
      if (reg.reference_number !== reference_number) {
        // Track mismatches for the brute-force lockout above.
        const e = fileAttachIp.get(ip)
        if (e) e.mismatches = (e.mismatches || 0) + 1
        return res.status(403).json({ error: 'Invalid reference number' })
      }
      // Registration email as a MANDATORY second factor on BOTH pending and
      // approved rows (2026-07-05 audit #8). The reference number alone is short
      // (~4 digits ≈ 9000 values), brute-forceable across a season with IP
      // rotation, and on a PENDING row the attach could overwrite already-uploaded
      // doc pointers. Requiring the registration email — which every legitimate
      // caller has (the create fallback + the nachreichen page both send it) —
      // closes the enumeration→overwrite path. Mismatches feed the same lockout.
      const email = String(req.body.email || '').trim().toLowerCase()
      if (!email || email !== String(reg.email || '').toLowerCase()) {
        const e = fileAttachIp.get(ip)
        if (e) e.mismatches = (e.mismatches || 0) + 1
        return res.status(403).json({ error: 'Invalid reference number' })
      }
      // Only accept well-formed directus_files UUIDs that ACTUALLY EXIST and live
      // in the PRIVATE registration folder — mirrors the create route's docs-exist
      // check so a brute-forcer can't point a victim's doc columns at fabricated
      // UUIDs OR at a public asset (which the quarantine hook would then privatise
      // and the sweep delete). On APPROVED rows the attach is fill-only: a ref+email
      // holder may complete missing documents but never silently REPLACE ones an
      // admin already reviewed at approval time.
      const fileId = (v) => (typeof v === 'string' && UUID_RE.test(v)) ? v : null
      const providedIds = [id_upload_front, id_upload_back, bb_doc_lizenz, bb_doc_freibrief, bb_doc_selfdecl, bb_doc_natdecl, bb_doc_u18parents, bb_doc_schoolcert]
        .map(fileId).filter(Boolean)
      if (providedIds.length) {
        const found = await database('directus_files')
          .whereIn('id', providedIds)
          .where('folder', REGISTRATION_FILES_FOLDER)
          .count('id as n').first()
        if (Number(found?.n || 0) !== providedIds.length) {
          return res.status(400).json({ error: 'One or more uploaded files not found' })
        }
      }
      const lockExisting = reg.status === 'approved'
      const update = {}
      const setDoc = (col, v) => {
        if (fileId(v) && !(lockExisting && reg[col])) update[col] = v
      }
      setDoc('id_upload_front', id_upload_front)
      setDoc('id_upload_back', id_upload_back)
      setDoc('bb_doc_lizenz', bb_doc_lizenz)
      setDoc('bb_doc_freibrief', bb_doc_freibrief)
      setDoc('bb_doc_selfdecl', bb_doc_selfdecl)
      setDoc('bb_doc_natdecl', bb_doc_natdecl)
      setDoc('bb_doc_u18parents', bb_doc_u18parents)
      setDoc('bb_doc_schoolcert', bb_doc_schoolcert)

      if (Object.keys(update).length) {
        await itemsService.updateOne(id, update)
      }

      res.json({ success: true })
    } catch (err) {
      log.error({
        msg: `registration files: ${err.message}`,
        endpoint: 'registration/:id/files',
        stack: err.stack,
      })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // Shared auth for the two public reference+email routes (doc-status and
  // doc-template). Both consume the attach limiter, including its brute-force
  // mismatch lockout, and both answer 404 on ANY mismatch so neither confirms
  // which half of the pair was wrong.
  //
  // Returns { status, body } to send, or { reg } on success — the caller decides
  // what to do with the row, and the DOC_STATUS_FIELDS/columns it needs are passed
  // in, because the two routes legitimately read different sets.
  const authByReferenceAndEmail = async (req, columns) => {
    const reference = String(req.query.reference || '').trim()
    const email = String(req.query.email || '').trim().toLowerCase()
    if (!reference || !email) {
      return { status: 400, body: { error: 'reference and email required' } }
    }

    const xff = req.headers['x-forwarded-for']
    const ip = req.headers['cf-connecting-ip']
      || (typeof xff === 'string' ? xff.split(',')[0].trim() : '')
      || req.ip || 'unknown'
    const now = Date.now()
    const ipEntry = fileAttachIp.get(ip)
    if (ipEntry && now < ipEntry.resetAt) {
      if (ipEntry.count >= 10 || ipEntry.mismatches >= 5) {
        return { status: 429, body: { error: 'Too many requests' } }
      }
      ipEntry.count++
    } else {
      fileAttachIp.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000, mismatches: 0 })
    }
    if (fileAttachIp.size > 1000) {
      for (const [k, v] of fileAttachIp) { if (now > v.resetAt) fileAttachIp.delete(k) }
    }

    const reg = await database('registrations')
      .whereRaw('LOWER(reference_number) = ?', [reference.toLowerCase()])
      .first(...columns)
    const emailOk = reg && String(reg.email || '').toLowerCase() === email
    if (!reg || !emailOk || !['pending', 'approved'].includes(reg.status)) {
      const e = fileAttachIp.get(ip)
      if (e) e.mismatches = (e.mismatches || 0) + 1
      return { status: 404, body: { error: 'Registration not found' } }
    }
    return { reg }
  }

  // Columns doc-status reads. doc-template reads these PLUS the personal fields
  // the licence forms carry — which is exactly why they are separate lists: the
  // JSON route must never start returning the PDF route's PII (see doc-template).
  const DOC_STATUS_FIELDS = [
    'id', 'status', 'email', 'membership_type', 'nationalitaet_code', 'nationalitaet_codes',
    'geburtsdatum', 'bb_situation', 'bb_recent_licence', 'reference_number',
    'id_upload_front', 'id_upload_back', 'bb_doc_lizenz', 'bb_doc_freibrief',
    'bb_doc_selfdecl', 'bb_doc_natdecl', 'bb_doc_u18parents', 'bb_doc_schoolcert',
    // Migration 358 — a waived document is not owed, so the nachreichen page
    // must not list it and the prefilled-form route must not serve it.
    'bb_docs_waived',
  ]

  // GET /kscw/registration/doc-status — document completeness for the public
  // "Dokumente nachreichen" (late re-upload) page. Auth = reference number +
  // registration email together; shares the attach limiter (incl. its
  // brute-force mismatch lockout). Responds 404 on ANY mismatch so the route
  // never confirms which half was wrong. Returns booleans only — no PII.
  router.get('/registration/doc-status', async (req, res) => {
    try {
      const auth = await authByReferenceAndEmail(req, DOC_STATUS_FIELDS)
      if (!auth.reg) return res.status(auth.status).json(auth.body)
      const reg = auth.reg

      // Same "Swiss beats foreign" rule as the create gate — a dual national
      // must not be told on the nachreichen page that documents are still
      // missing which the create route never required of them.
      const natCode = fibaNatCode(reg.nationalitaet_codes, reg.nationalitaet_code)
      const required = reg.membership_type === 'basketball'
        ? bbRequiredDocsAfterWaiver(reg.bb_situation, natCode, reg.geburtsdatum, reg.bb_recent_licence, reg.bb_docs_waived)
        : []
      return res.json({
        id: reg.id,
        reference_number: reg.reference_number,
        membership_type: reg.membership_type,
        status: reg.status,
        required,
        docs: {
          id_upload_front: !!reg.id_upload_front,
          id_upload_back: !!reg.id_upload_back,
          bb_doc_lizenz: !!reg.bb_doc_lizenz,
          bb_doc_freibrief: !!reg.bb_doc_freibrief,
          bb_doc_selfdecl: !!reg.bb_doc_selfdecl,
          bb_doc_natdecl: !!reg.bb_doc_natdecl,
          bb_doc_u18parents: !!reg.bb_doc_u18parents,
          bb_doc_schoolcert: !!reg.bb_doc_schoolcert,
        },
      })
    } catch (err) {
      log.error({
        msg: `registration doc-status: ${err.message}`,
        endpoint: 'registration/doc-status',
        stack: err.stack,
      })
      res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /kscw/registration/doc-template/:field — a licence form, pre-filled from
  // the applicant's own registration, for the public nachreichen page.
  //
  // Exists because the recovery page told families WHICH documents were missing
  // and gave them no way to obtain any of them (A. Jung, REG-2026-9584,
  // 13.08.2026: "Wie finde ich diese Unterlagen, damit ich sie nochmals
  // ausdrucken, unterschreiben und hochladen kann?"). The blank PDFs were only
  // ever linked from the registration form itself, which a family that already
  // registered has no reason to revisit.
  //
  // ⚠ Server-side on purpose. The obvious alternative — return the applicant's
  // details from doc-status and let the page fill the PDF in the browser, reusing
  // the filler that page's sibling already ships — would turn a booleans-only
  // route into a minor's full name, birthdate and home address behind a 4-digit
  // reference plus an email. Today a lucky guess is worth nothing; that change
  // would make it worth a dossier. Here the PII only ever leaves as a PDF the
  // family already possesses the contents of, and doc-status stays booleans-only.
  const TEMPLATE_CACHE = new Map() // file → ArrayBuffer
  const TEMPLATE_MAX_BYTES = 8 * 1024 * 1024

  // The blank forms are published and versioned on the public website, so they are
  // fetched rather than vendored — one copy of each PDF, and Swiss Basketball's
  // reissues land by replacing that copy. Cached for the life of the process:
  // these change a few times a decade and the fetch is the slow part.
  const fetchTemplate = async (file) => {
    if (TEMPLATE_CACHE.has(file)) return TEMPLATE_CACHE.get(file)
    const url = `${KSCW_WEBSITE_URL}/docs/${file}`
    const resp = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!resp.ok) throw new Error(`template fetch ${resp.status} for ${url}`)
    const buf = await resp.arrayBuffer()
    if (!buf.byteLength || buf.byteLength > TEMPLATE_MAX_BYTES) {
      throw new Error(`template ${file} has implausible size ${buf.byteLength}`)
    }
    TEMPLATE_CACHE.set(file, buf)
    return buf
  }

  router.get('/registration/doc-template/:field', async (req, res) => {
    const field = String(req.params.field || '')
    try {
      const tpl = BB_PDF_TEMPLATES[field]
      // Unknown field is rejected BEFORE the lookup, so this route cannot be used
      // to probe which columns exist.
      if (!tpl) return res.status(404).json({ error: 'No template for this document' })

      const auth = await authByReferenceAndEmail(req, [
        ...DOC_STATUS_FIELDS,
        'vorname', 'nachname', 'adresse', 'plz', 'ort', 'geschlecht',
        'nationalitaet', 'federation_of_origin',
      ])
      if (!auth.reg) return res.status(auth.status).json(auth.body)
      const reg = auth.reg

      // Only hand out a form the applicant actually owes and has not already
      // filed. Without this the route would serve any of the five to anyone
      // holding the pair, including forms their situation never required.
      const natCode = fibaNatCode(reg.nationalitaet_codes, reg.nationalitaet_code)
      const required = reg.membership_type === 'basketball'
        ? bbRequiredDocsAfterWaiver(reg.bb_situation, natCode, reg.geburtsdatum, reg.bb_recent_licence, reg.bb_docs_waived)
        : []
      if (!required.includes(field) || reg[field]) {
        return res.status(404).json({ error: 'No template for this document' })
      }

      const { PDFDocument, StandardFonts } = await import('pdf-lib')
      const pdfDoc = await PDFDocument.load(await fetchTemplate(tpl.file), { ignoreEncryption: true })
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica)

      // FIBA's origin box wants the BODY that licensed the player ("FIP (Italy)"),
      // in English, on an English form. Empty stays empty — a blank the family
      // completes beats us asserting a federation they never named.
      const fedCode = String(reg.federation_of_origin || '').trim().toUpperCase()
      let federationOfOrigin = ''
      if (fedCode) {
        let country = fedCode
        try { country = new Intl.DisplayNames(['en'], { type: 'region' }).of(fedCode) || fedCode } catch { /* unknown code */ }
        const fed = federationName(fedCode, 'basketball')
        federationOfOrigin = fed ? `${fed} (${country})` : country
      }

      fillBbForm(field, pdfDoc, {
        vorname: reg.vorname,
        nachname: reg.nachname,
        email: reg.email,
        adresse: reg.adresse,
        plz: reg.plz,
        ort: reg.ort,
        geburtsdatum: reg.geburtsdatum,
        nationalitaet: reg.nationalitaet,
        nationalitaetCodes: String(reg.nationalitaet_codes || '')
          .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
        geschlecht: reg.geschlecht,
        situation: reg.bb_situation,
        federationOfOrigin,
      }, {
        font,
        fontSize: 10,
        onEncodeError: (name, err) => log.warn({
          msg: `doc-template ${field}: field "${name}" — ${err.message}`,
          endpoint: 'registration/doc-template',
        }),
      })

      const bytes = Buffer.from(await pdfDoc.save())
      // Name the file after the person, not the form: a family downloading three
      // of these otherwise ends up with three indistinguishable PDFs.
      const safeName = `${tpl.filename}_${reg.nachname}_${reg.vorname}`
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80)
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`)
      res.setHeader('Content-Length', String(bytes.length))
      // Personal data — never let a shared cache keep a copy.
      res.setHeader('Cache-Control', 'private, no-store')
      log.info({ msg: 'Registration doc template served', field, ref: reg.reference_number })
      return res.end(bytes)
    } catch (err) {
      log.error({
        msg: `registration/doc-template: ${err.message}`,
        endpoint: 'registration/doc-template',
        field,
        stack: err.stack,
      })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/registration/:id/request-docs — staff-triggered "please (re-)upload
  // your documents" email.
  //
  // Exists because documents can go missing AFTER a registration was approved and
  // the applicant has no way to know: the 2026-07-04 Safari upload failure
  // (create-before-upload, zero server enforcement) and the 2026-07-13 upload
  // truncation (a `req.on('data')` counter ate the leading chunks of 36 files, all
  // unrecoverable) both left approved members with an incomplete Swiss Basketball
  // dossier. Re-opening the registration is the wrong repair — approval already
  // created the member, the invite and the ClubDesk contact, and re-approving
  // would re-fire all three. So the row stays `approved` and this only emails the
  // applicant their prefilled link to the public nachreichen page, which the
  // attach route already accepts for approved rows (fill-only).
  //
  // Staff-only and it does not mutate the registration — but it SENDS on the club's
  // behalf to a real family, so it is actor-logged like any other state change
  // (CLAUDE.md → audit logging).
  router.post('/registration/:id/request-docs', async (req, res) => {
    try {
      if (!req.accountability?.user) {
        return res.status(401).json({ error: 'Authentication required' })
      }

      // Permission: Directus admin, or app-role admin/superuser/vorstand, or the
      // sport admin for this registration's sport.
      const actor = await database('members')
        .where('user', req.accountability.user)
        .first('id', 'role', 'first_name', 'last_name')
      const actorRoles = Array.isArray(actor?.role) ? actor.role
        : (() => { try { return JSON.parse(actor?.role || '[]') } catch { return [] } })()

      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid registration id' })
      }
      const reg = await database('registrations').where('id', id)
        .first('id', 'status', 'email', 'vorname', 'nachname', 'locale', 'membership_type',
          'reference_number', 'nationalitaet_code', 'nationalitaet_codes', 'geburtsdatum',
          'bb_situation', 'bb_recent_licence', 'bb_docs_waived',
          'id_upload_front', 'id_upload_back', 'bb_doc_lizenz', 'bb_doc_freibrief',
          'bb_doc_selfdecl', 'bb_doc_natdecl', 'bb_doc_u18parents', 'bb_doc_schoolcert')
      if (!reg) return res.status(404).json({ error: 'Registration not found' })

      const sportRole = reg.membership_type === 'basketball' ? 'bb_admin'
        : reg.membership_type === 'volleyball' ? 'vb_admin' : null
      const allowed = req.accountability.admin === true
        || actorRoles.includes('admin')
        || actorRoles.includes('superuser')
        || actorRoles.includes('vorstand')
        || (!!sportRole && actorRoles.includes(sportRole))
      if (!allowed) return res.status(403).json({ error: 'Not authorized' })

      // Only pending/approved rows can still receive documents — the attach route
      // enforces the same set, so mailing a link for a rejected row would send the
      // family to a page that 404s.
      if (!['pending', 'approved'].includes(reg.status)) {
        return res.status(400).json({ error: 'Registration is not open', code: 'not_open' })
      }
      if (!reg.email || !reg.email.trim()) {
        return res.status(400).json({ error: 'Registration has no email address', code: 'no_email' })
      }
      if (!reg.reference_number) {
        return res.status(400).json({ error: 'Registration has no reference number', code: 'no_reference' })
      }

      // Same required-set rule as the create gate, doc-status and the approval
      // hook — one source of truth, so the email never asks for a document the
      // applicant does not owe.
      const natCode = fibaNatCode(reg.nationalitaet_codes, reg.nationalitaet_code)
      const required = reg.membership_type === 'basketball'
        ? bbRequiredDocsAfterWaiver(reg.bb_situation, natCode, reg.geburtsdatum, reg.bb_recent_licence, reg.bb_docs_waived)
        : []
      const missing = required.filter((f) => !reg[f])
      if (!missing.length) {
        return res.status(400).json({ error: 'No documents are missing', code: 'nothing_missing' })
      }

      const locale = REG_LOCALES.includes(reg.locale) ? reg.locale : 'de'
      const { subject, html } = await buildDocsRequestEmail(reg, locale, missing)

      const { MailService } = services
      const mail = new MailService({ schema: await getSchema(), knex: database })
      await mail.send({
        to: reg.email,
        subject,
        html,
        // EMAIL_FROM is wiedisync@noreply.kscw.ch, and the copy tells the family
        // they can simply reply — without this that reply bounces into a void.
        replyTo: OWNER_EMAIL,
      })

      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'request_docs',
        collection: 'registrations',
        recordId: id,
        data: { reference_number: reg.reference_number, email: reg.email, missing, locale },
      })

      // Archive what actually went out. `user_logs` records that a send happened;
      // this records the message, so "what exactly did we tell this family?" is
      // answerable months later without reconstructing it from the template as it
      // reads today (which may since have been edited).
      await recordEmailSend(database, log, {
        templateKey: DOCS_REQUEST_KEY,
        locale,
        to: reg.email,
        subject,
        html,
        collection: 'registrations',
        recordId: id,
        actor,
      })

      log.info({ msg: 'Registration document request sent', id, ref: reg.reference_number, missing: missing.length })
      return res.json({ success: true, email: reg.email, missing })
    } catch (err) {
      log.error({
        msg: `registration/request-docs: ${err.message}`,
        endpoint: 'registration/request-docs',
        stack: err.stack,
      })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/registration/docs-request-preview — render the document-request
  // email without sending it.
  //
  // The editor needs to show the message as the family will see it, and the only
  // trustworthy way to do that is to run the real builder: a page that
  // re-implements the rendering will drift from the sender the first time either
  // side changes. Optional `overrides` lets the page preview UNSAVED edits, so a
  // mistake is visible before it is stored, let alone sent.
  router.post('/registration/docs-request-preview', async (req, res) => {
    try {
      if (!req.accountability?.user) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const actor = await database('members')
        .where('user', req.accountability.user)
        .first('id', 'role')
      const actorRoles = Array.isArray(actor?.role) ? actor.role
        : (() => { try { return JSON.parse(actor?.role || '[]') } catch { return [] } })()
      const allowed = req.accountability.admin === true
        || ['admin', 'superuser', 'vorstand', 'bb_admin'].some((r) => actorRoles.includes(r))
      if (!allowed) return res.status(403).json({ error: 'Not authorized' })

      const locale = REG_LOCALES.includes(req.body?.locale) ? req.body.locale : 'de'
      const overrides = req.body?.overrides && typeof req.body.overrides === 'object' ? req.body.overrides : null
      if (overrides) {
        // Same rules the write hook applies — previewing must not be a way to see
        // what an invalid template would look like and assume it is sendable.
        const errors = validateTemplate(DOCS_REQUEST_KEY, overrides)
        if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 'template_invalid', errors })
      }

      // Prefer a real registration that still owes documents, so the preview shows
      // a genuine list rather than an invented one; fall back to a sample.
      let reg = null
      if (req.body?.registration_id) {
        reg = await database('registrations').where('id', Number(req.body.registration_id))
          .first('id', 'vorname', 'email', 'reference_number', 'membership_type', 'nationalitaet_code',
            'nationalitaet_codes', 'geburtsdatum', 'bb_situation', 'bb_recent_licence',
            'bb_docs_waived',
            'id_upload_front', 'id_upload_back', 'bb_doc_lizenz', 'bb_doc_freibrief',
            'bb_doc_selfdecl', 'bb_doc_natdecl', 'bb_doc_u18parents', 'bb_doc_schoolcert')
      }
      let missing
      if (reg) {
        const natCode = fibaNatCode(reg.nationalitaet_codes, reg.nationalitaet_code)
        const required = bbRequiredDocsAfterWaiver(reg.bb_situation, natCode, reg.geburtsdatum, reg.bb_recent_licence, reg.bb_docs_waived)
        missing = required.filter((f) => !reg[f])
      }
      if (!reg || !missing?.length) {
        reg = {
          vorname: 'Chiara', email: 'beispiel@example.ch', reference_number: 'REG-2026-0000',
          membership_type: 'basketball',
        }
        missing = ['id_upload_front', 'id_upload_back', 'bb_doc_lizenz', 'bb_doc_selfdecl', 'bb_doc_natdecl']
      }

      const { subject, html } = await buildDocsRequestEmail(reg, locale, missing, overrides)
      return res.json({ subject, html, sample: !req.body?.registration_id, missing })
    } catch (err) {
      log.error({
        msg: `registration/docs-request-preview: ${err.message}`,
        endpoint: 'registration/docs-request-preview',
        stack: err.stack,
      })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/registration/upload?filename=… — public single-file upload for
  // registration documents. Replaces the anonymous core POST /files for this
  // flow: the file is created INSIDE the private registration folder
  // (migration 169) instead of folder-less/anon-readable, and MIME + size are
  // enforced server-side. The browser sends the raw File as the request body
  // (fetch body: file → Content-Type = the file's own type; no multipart
  // parsing needed). Orphans (abandoned forms, re-picks) are swept nightly by
  // the kscw-hooks registration-docs cron. Per-IP limited.
  const uploadIp = new Map() // ip → { count, resetAt }
  router.post('/registration/upload', async (req, res) => {
    try {
      const xff = req.headers['x-forwarded-for']
      const ip = req.headers['cf-connecting-ip']
        || (typeof xff === 'string' ? xff.split(',')[0].trim() : '')
        || req.ip || 'unknown'
      const now = Date.now()
      const entry = uploadIp.get(ip)
      if (entry && now < entry.resetAt) {
        if (entry.count >= 30) return res.status(429).json({ error: 'Too many uploads. Please try again later.' })
        entry.count++
      } else {
        uploadIp.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 })
      }
      if (uploadIp.size > 1000) {
        for (const [k, v] of uploadIp) { if (now > v.resetAt) uploadIp.delete(k) }
      }

      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (!UPLOAD_ALLOWED_MIME.has(type)) {
        return res.status(400).json({ error: 'Invalid file type. Allowed: JPG, PNG, WebP, GIF, PDF.' })
      }
      if (Number(req.headers['content-length'] || 0) > UPLOAD_MAX_BYTES) {
        return res.status(413).json({ error: 'File too large (max 10 MB).' })
      }

      const rawName = String(req.query.filename || 'document')
      const filename = rawName.replace(/[\\/\u0000-\u001f]/g, '').slice(0, 200) || 'document'

      // Hard cap while streaming — Content-Length alone is client-controlled.
      //
      // ⚠ The counter MUST sit INSIDE the pipeline, never in a `req.on('data')` listener.
      // Attaching a 'data' listener switches the request into flowing mode IMMEDIATELY:
      // every chunk emitted before FilesService.uploadOne() attaches its own pipe goes to
      // that listener and is DISCARDED. uploadOne then stores only what arrives after it
      // starts reading, so the file loses its leading bytes.
      //
      // This is not hypothetical. It silently truncated the FRONT of 36 registration
      // documents (government ID scans + Basketball licence PDFs) between 2026-07-06, when
      // this endpoint shipped, and 2026-07-13. The stored files kept a valid PDF trailer
      // (%%EOF) and a plausible filesize but lost the %PDF header, so nothing looked wrong
      // until a reviewer opened one (REG-2026-4844). The dropped prefix was never written
      // anywhere — unrecoverable; five registrants had to re-upload.
      //
      // A Transform COUNTS AND FORWARDS each chunk, so the bytes reach uploadOne intact
      // while the cap still fires mid-stream (no need to buffer the whole body first).
      let bytes = 0
      const capped = new Transform({
        transform(chunk, _enc, cb) {
          bytes += chunk.length
          if (bytes > UPLOAD_MAX_BYTES) {
            cb(Object.assign(new Error('File too large (max 10 MB).'), { status: 413 }))
            return
          }
          cb(null, chunk)
        },
      })
      req.on('error', (err) => capped.destroy(err))
      req.pipe(capped)

      const { FilesService } = services
      const schema = await getSchema()
      const filesService = new FilesService({ schema, knex: database })
      const storage = (process.env.STORAGE_LOCATIONS || 'local').split(',')[0].trim()
      const newFileId = await filesService.uploadOne(capped, {
        storage,
        filename_download: filename,
        type,
        folder: REGISTRATION_FILES_FOLDER,
      })
      log.info({ msg: 'Registration document uploaded', file: newFileId, type, bytes })
      return res.json({ id: newFileId })
    } catch (err) {
      log.error({
        msg: `registration upload: ${err.message}`,
        endpoint: 'registration/upload',
        stack: err.stack,
      })
      res.status(500).json({ error: 'Upload failed' })
    }
  })

  // ── Duplicate detection: public live check + admin flag/merge ───────────────

  // Per-IP throttle for the live form check. It fires as somebody types (the
  // form debounces to blur), so the budget is generous — but it must exist:
  // the route answers "is this exact person already an active member", and
  // without a limit it becomes a membership oracle to grind against.
  const dupCheckIp = new Map() // ip → { count, resetAt }

  const clientIp = (req) => {
    const xff = req.headers['x-forwarded-for']
    return req.headers['cf-connecting-ip']
      || (typeof xff === 'string' ? xff.split(',')[0].trim() : '')
      || req.ip || 'unknown'
  }

  const ALL_MEMBERSHIP_TYPES = ['volleyball', 'basketball', 'passive']

  /** Which registrations this caller may see, as a membership_type list — or
   *  null when they may see none. Same tiers as /registration/:id/request-docs:
   *  Directus admin and app-role admin/superuser/vorstand see everything; a
   *  sport admin sees their own sport only.
   *
   *  ⚠ Returns the SCOPE, not a yes/no. The batch route covers a whole page of
   *  mixed-sport rows, so a boolean gate keyed on one membership_type answered
   *  403 for every pure vb_admin/bb_admin — and they are exactly the people who
   *  approve these registrations, so the flags would have been invisible to the
   *  staff who most need them (the badge fetch fails soft, so it would have
   *  looked like "no duplicates" rather than an error). */
  const registrationScope = async (req) => {
    if (!req.accountability?.user) return { status: 401, error: 'Authentication required' }
    const actor = await database('members').where('user', req.accountability.user).first('id', 'role')
    const actorRoles = Array.isArray(actor?.role) ? actor.role
      : (() => { try { return JSON.parse(actor?.role || '[]') } catch { return [] } })()
    if (req.accountability.admin === true
      || actorRoles.includes('admin')
      || actorRoles.includes('superuser')
      || actorRoles.includes('vorstand')) {
      return { sports: ALL_MEMBERSHIP_TYPES }
    }
    // Passive registrations have no sport, so they stay with the global tiers —
    // a sport admin has no claim on them.
    const sports = []
    if (actorRoles.includes('vb_admin')) sports.push('volleyball')
    if (actorRoles.includes('bb_admin')) sports.push('basketball')
    return sports.length ? { sports } : { status: 403, error: 'Not authorized' }
  }

  /** Single-registration variant: resolve the scope, then check this row's sport. */
  const assertRegistrationAdmin = async (req, membershipType) => {
    const scope = await registrationScope(req)
    if (scope.status) return scope
    return scope.sports.includes(membershipType) ? null : { status: 403, error: 'Not authorized' }
  }

  // POST /kscw/registration/check-duplicate — PUBLIC live check for the website form.
  //
  // ⚠ Answers a strict BOOLEAN and nothing else. It never returns the member's
  // id, name, email or status, and it only says `true` when first name AND last
  // name AND email all match an ACTIVE member — so a caller has to already know
  // the whole identity to learn anything, which makes it useless for harvesting.
  // The softer tiers (returning member, name/birthdate resemblance) are staff-only
  // and are deliberately NOT surfaced here: telling a stranger "someone with this
  // birthday is on file" is exactly the leak this shape avoids.
  router.post('/registration/check-duplicate', async (req, res) => {
    try {
      const ip = clientIp(req)
      const now = Date.now()
      const entry = dupCheckIp.get(ip)
      if (entry && now < entry.resetAt) {
        if (entry.count >= 60) return res.status(429).json({ error: 'Too many requests' })
        entry.count++
      } else {
        dupCheckIp.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 })
      }
      if (dupCheckIp.size > 1000) {
        for (const [k, v] of dupCheckIp) { if (now > v.resetAt) dupCheckIp.delete(k) }
      }

      const { vorname, nachname, email } = req.body || {}
      if (!vorname || !nachname || !email) return res.json({ already_member: false })
      const emailNorm = normalizeEmail(email)
      if (!emailNorm.ok || !emailNorm.value) return res.json({ already_member: false })

      const blocker = await findBlockingMember(database, { vorname, nachname, email: emailNorm.value })
      return res.json({ already_member: !!blocker })
    } catch (err) {
      log.error({ msg: `registration/check-duplicate: ${err.message}`, endpoint: 'registration/check-duplicate', stack: err.stack })
      // Never fail the form over an advisory check — the create route re-runs
      // the same rule and is the one that actually decides.
      return res.json({ already_member: false })
    }
  })

  // POST /kscw/registration/duplicates — batch flags for the /admin/anmeldungen list.
  // One call for the whole page instead of a probe per row.
  router.post('/registration/duplicates', async (req, res) => {
    try {
      const scope = await registrationScope(req)
      if (scope.status) return res.status(scope.status).json({ error: scope.error })

      const ids = Array.isArray(req.body?.registration_ids)
        ? req.body.registration_ids.map(Number).filter(Number.isInteger).slice(0, 500)
        : []
      if (!ids.length) return res.json({ flags: {} })

      // Scoped in the QUERY, not filtered after: a sport admin asking about a
      // registration outside their sport simply gets no flag for it, and learns
      // nothing about a row they cannot open.
      const regs = await database('registrations').whereIn('id', ids)
        .whereIn('membership_type', scope.sports)
        .select('id', 'vorname', 'nachname', 'email', 'telefon_mobil', 'geburtsdatum', 'member')
      // Four queries for the whole page, not four per row. A registration
      // already linked to a member is not "a possible duplicate of that member"
      // — it IS them — so the batch excludes each row's own link, which is what
      // stops an approved row flagging itself forever.
      const results = await findDuplicateCandidatesBatch(database, regs)
      const flags = {}
      for (const reg of regs) {
        const { level, candidates } = results.get(reg.id)
        if (level === 'none') continue
        const top = candidates[0]
        flags[String(reg.id)] = {
          level,
          count: candidates.length,
          member_id: top.id,
          member_name: [top.first_name, top.last_name].filter(Boolean).join(' '),
          match: top.match,
          active: !!top.kscw_membership_active,
        }
      }
      return res.json({ flags })
    } catch (err) {
      log.error({ msg: `registration/duplicates: ${err.message}`, endpoint: 'registration/duplicates', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // GET /kscw/registration/:id/duplicates — candidates + field-by-field diff for
  // the expanded row. One diff per candidate, so staff pick the right person
  // before they pick the fields.
  router.get('/registration/:id/duplicates', async (req, res) => {
    try {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid registration id' })
      const reg = await database('registrations').where('id', id).first()
      if (!reg) return res.status(404).json({ error: 'Registration not found' })

      const denied = await assertRegistrationAdmin(req, reg.membership_type)
      if (denied) return res.status(denied.status).json({ error: denied.error })

      const { level, candidates } = await findDuplicateCandidates(database, reg, { excludeMemberId: reg.member })
      // Name the member this row is ALREADY linked to. The candidate list
      // deliberately excludes them (or every approved row would flag itself
      // forever), which means the panel can only ever offer somebody ELSE — so
      // it has to say out loud that a link exists, or a merge silently
      // re-points the registration and orphans the member the approval made.
      const linked = reg.member
        ? await database('members').where('id', reg.member).first('id', 'first_name', 'last_name', 'email')
        : null
      const withDiff = []
      for (const c of candidates) {
        withDiff.push({
          member_id: c.id,
          name: [c.first_name, c.last_name].filter(Boolean).join(' '),
          email: c.email,
          match: c.match,
          reasons: c.reasons,
          active: !!c.kscw_membership_active,
          has_account: !!c.user,
          clubdesk_id: c.clubdesk_id || null,
          shell: !!c.shell,
          diff: await buildMergeDiff(database, reg, c),
        })
      }
      return res.json({
        level,
        linked_member: reg.member ?? null,
        linked_member_name: linked ? [linked.first_name, linked.last_name].filter(Boolean).join(' ') : null,
        candidates: withDiff,
      })
    } catch (err) {
      log.error({ msg: `registration/:id/duplicates: ${err.message}`, endpoint: 'registration/duplicates', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })

  // POST /kscw/registration/:id/merge — link the registration to an existing
  // member and apply the chosen fields onto that member.
  //
  // Merge does NOT approve. It only settles identity ("this form is member
  // #195") plus whatever data staff ticked; the normal approve button still
  // runs afterwards for the team roster, the ClubDesk push and the email — and
  // now finds the link already stamped, so it can no longer mint a second
  // member row for the same person.
  router.post('/registration/:id/merge', async (req, res) => {
    try {
      const id = Number(req.params.id)
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid registration id' })
      const reg = await database('registrations').where('id', id).first()
      if (!reg) return res.status(404).json({ error: 'Registration not found' })

      const denied = await assertRegistrationAdmin(req, reg.membership_type)
      if (denied) return res.status(denied.status).json({ error: denied.error })

      const memberId = Number(req.body?.member_id)
      if (!Number.isInteger(memberId) || memberId <= 0) {
        return res.status(400).json({ error: 'member_id required', code: 'member_required' })
      }
      const member = await database('members').where('id', memberId).first()
      if (!member) return res.status(404).json({ error: 'Member not found', code: 'no_member' })

      // ⚠ Re-pointing an existing link is never a silent operation. If this
      // registration was already approved, `reg.member` is the member the
      // approval created or linked — and that row owns a signup token, team
      // roster rows and a ClubDesk push flag. Overwriting the link leaves it
      // referenced by nothing. Exactly the shape of the legacy prod rows this
      // feature exists to clean up, so it must be a decision, not a side effect.
      if (reg.member && Number(reg.member) !== memberId && req.body?.relink !== true) {
        const current = await database('members').where('id', reg.member)
          .first('id', 'first_name', 'last_name')
        return res.status(409).json({
          error: 'This registration is already linked to another member.',
          code: 'already_linked',
          linked_member: reg.member,
          linked_member_name: current ? [current.first_name, current.last_name].filter(Boolean).join(' ') : null,
        })
      }
      const relinkedFrom = reg.member && Number(reg.member) !== memberId ? Number(reg.member) : null

      // Only fields this exact pairing actually offers can be written — the
      // client sends KEYS, never values, so a crafted request cannot set a
      // column to something the registration does not contain.
      const diff = await buildMergeDiff(database, reg, member)
      const patch = buildMergePatch(diff, req.body?.fields)

      if (Object.keys(patch).length) {
        await database('members').where('id', memberId).update(patch)
        // A merged member has gained contact fields ClubDesk should see.
        try {
          await database('members').where('id', memberId).update({ clubdesk_push_pending: true })
        } catch (flagErr) {
          log.warn({ msg: `clubdesk push-flag (merge) failed: ${flagErr.message}`, memberId })
        }
      }
      await database('registrations').where('id', id).update({ member: memberId })

      // Raw-knex writes bypass Directus's own revision trail, so the actor is
      // captured explicitly (CLAUDE.md → audit logging). Both sides are logged:
      // the member row that changed, and the registration that was re-pointed.
      // ⚠ Field NAMES only, never the values. The patch can carry ahv_nummer,
      // iban and birthdate, and `user_logs` is append-only by design (the
      // update/delete filter hooks refuse everyone), so a value written here
      // can never be redacted again. The registration-side entry below has
      // always logged keys; this one has to match.
      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'update',
        collection: 'members',
        recordId: memberId,
        data: {
          merged_from_registration: reg.reference_number,
          fields_applied: Object.keys(patch),
          ...(relinkedFrom ? { relinked_from_member: relinkedFrom } : {}),
        },
      })
      await writeUserLog(database, log, {
        accountability: req.accountability,
        action: 'update',
        collection: 'registrations',
        recordId: id,
        data: {
          merged_into_member: memberId,
          fields_applied: Object.keys(patch),
          ...(relinkedFrom ? { relinked_from_member: relinkedFrom } : {}),
        },
      })

      log.info({ msg: 'Registration merged into existing member', id, memberId, fields: Object.keys(patch) })
      return res.json({ member_id: memberId, applied: Object.keys(patch), relinked_from: relinkedFrom })
    } catch (err) {
      log.error({ msg: `registration/:id/merge: ${err.message}`, endpoint: 'registration/merge', stack: err.stack })
      return res.status(500).json({ error: 'Internal error' })
    }
  })
}
