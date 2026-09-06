/**
 * Push notification i18n
 *
 * Buckets recipient member ids by their `members.language` and provides a
 * translation table for every push string the backend produces. Web push
 * payloads are baked at send time, so the recipient's in-app locale toggle
 * cannot localize them after delivery — strings must be picked per recipient
 * before fanout.
 *
 * `members.language` is a free-text DB column with values:
 *   german | swiss_german | english | french | italian | (null)
 * which we map to 5 short codes: de | gsw | en | fr | it.
 * Null / unknown falls back to `de` (canonical club language, same default
 * Postgres uses for new rows).
 */

// ── Member.language → short code ────────────────────────────────────
const LANG_TO_CODE = {
  german: 'de',
  swiss_german: 'gsw',
  english: 'en',
  french: 'fr',
  italian: 'it',
}

const LOCALES = ['de', 'gsw', 'en', 'fr', 'it']

export function memberLangToCode(lang) {
  return LANG_TO_CODE[lang] || 'de'
}

/**
 * Group `memberIds` into per-locale buckets keyed by short code.
 * Members without a `language` row (or with an unrecognised value) land in `de`.
 *
 * @param {object} db - knex instance
 * @param {Array<number|string>} memberIds
 * @returns {Promise<{de: number[], gsw: number[], en: number[], fr: number[], it: number[]}>}
 */
export async function bucketMembersByLocale(db, memberIds) {
  const buckets = { de: [], gsw: [], en: [], fr: [], it: [] }
  if (!Array.isArray(memberIds) || memberIds.length === 0) return buckets
  const ids = [...new Set(memberIds.filter(Boolean))]
  if (ids.length === 0) return buckets
  const rows = await db('members').whereIn('id', ids).select('id', 'language')
  const langMap = new Map()
  for (const r of rows) langMap.set(r.id, r.language)
  for (const id of ids) {
    const code = memberLangToCode(langMap.get(id))
    buckets[code].push(id)
  }
  return buckets
}

// ── Translation table ───────────────────────────────────────────────
// Keys mirror the call sites that previously hardcoded German strings.
// Variables are substituted via `{name}` / `{team}` placeholders.

const T = {
  'tomorrow.title': {
    de: 'Morgen',
    gsw: 'Morn',
    en: 'Tomorrow',
    fr: 'Demain',
    it: 'Domani',
  },
  'tomorrow.body': {
    de: 'Du hast morgen eine Aktivität',
    gsw: 'Du häsch morn ä Aktivität',
    en: 'You have an activity tomorrow',
    fr: 'Tu as une activité demain',
    it: 'Hai un’attività domani',
  },
  'deadline.title': {
    de: 'RSVP-Erinnerung',
    gsw: 'RSVP-Erinnerig',
    en: 'RSVP reminder',
    fr: 'Rappel RSVP',
    it: 'Promemoria RSVP',
  },
  'deadline.body': {
    de: 'Anmeldefrist läuft morgen ab',
    gsw: 'Aamäldefrist lauft morn ab',
    en: 'Sign-up deadline is tomorrow',
    fr: 'La date limite d’inscription est demain',
    it: 'La scadenza per l’iscrizione è domani',
  },
  // Deadline sweep (migration 352) — the member never answered, so the daily
  // cron declined them for it and (where the team's late_signin rule is on)
  // fined them. ONE push covers both: the fine's own create-action push is
  // suppressed for auto-issued rows so this is the only buzz.
  // {date} = dd.mm.yyyy, {team} = team name, {amount} = "CHF 20.00".
  'autoDeclinedTraining.title': {
    de: 'Training: Frist verpasst',
    gsw: 'Training: Frist verpasst',
    en: 'Training: deadline missed',
    fr: 'Entraînement : délai dépassé',
    it: 'Allenamento: scadenza mancata',
  },
  'autoDeclinedGame.title': {
    de: 'Spiel: Frist verpasst',
    gsw: 'Spiel: Frist verpasst',
    en: 'Game: deadline missed',
    fr: 'Match : délai dépassé',
    it: 'Partita: scadenza mancata',
  },
  'autoDeclined.body': {
    de: '{date} — du bist als nicht dabei eingetragen',
    gsw: '{date} — du bisch als nöd debi iiträit',
    en: '{date} — you\'ve been marked as not coming',
    fr: '{date} — tu es inscrit comme absent',
    it: '{date} — sei registrato come assente',
  },
  'autoDeclinedFined.body': {
    de: '{date} — als nicht dabei eingetragen, Busse {amount}',
    gsw: '{date} — als nöd debi iiträit, Bueß {amount}',
    en: '{date} — marked as not coming, fine {amount}',
    fr: '{date} — inscrit comme absent, amende {amount}',
    it: '{date} — registrato come assente, multa {amount}',
  },
  'joinRequest.title': {
    de: 'Neue Beitrittsanfrage: {name}',
    gsw: 'Neui Bytrittsaafrog: {name}',
    en: 'New join request: {name}',
    fr: 'Nouvelle demande d’adhésion : {name}',
    it: 'Nuova richiesta di adesione: {name}',
  },
  'joinRequest.body': {
    de: '{name} möchte {team} beitreten',
    gsw: '{name} möcht zu {team}',
    en: '{name} wants to join {team}',
    fr: '{name} souhaite rejoindre {team}',
    it: '{name} vuole unirsi a {team}',
  },
  'expense.paid.title': {
    de: 'Spesen bezahlt',
    gsw: 'Spese zahlt',
    en: 'Expense paid',
    fr: 'Note de frais payée',
    it: 'Spesa pagata',
  },
  'expense.paid.body': {
    de: 'Deine Spesen über {amount} wurden bezahlt',
    gsw: 'Dini Spese über {amount} sind zahlt worde',
    en: 'Your expense of {amount} has been paid',
    fr: 'Ta note de frais de {amount} a été payée',
    it: 'La tua spesa di {amount} è stata pagata',
  },
  'expense.rejected.title': {
    de: 'Spesen abgelehnt',
    gsw: 'Spese abglehnt',
    en: 'Expense rejected',
    fr: 'Note de frais refusée',
    it: 'Spesa respinta',
  },
  'expense.rejected.body': {
    de: 'Deine Spesen über {amount} wurden abgelehnt',
    gsw: 'Dini Spese über {amount} sind abglehnt worde',
    en: 'Your expense of {amount} was rejected',
    fr: 'Ta note de frais de {amount} a été refusée',
    it: 'La tua spesa di {amount} è stata respinta',
  },
  'delegation.accepted.title': {
    de: 'Delegation angenommen',
    gsw: 'Delegation aagnoh',
    en: 'Delegation accepted',
    fr: 'Délégation acceptée',
    it: 'Delega accettata',
  },
  'delegation.accepted.body': {
    de: 'Deine Schreiber-Delegation wurde angenommen',
    gsw: 'Dini Schryber-Delegation isch aagnoh worde',
    en: 'Your scorer delegation was accepted',
    fr: 'Ta délégation de marqueur a été acceptée',
    it: 'La tua delega di segnapunti è stata accettata',
  },
  'delegation.declined.title': {
    de: 'Delegation abgelehnt',
    gsw: 'Delegation abglehnt',
    en: 'Delegation declined',
    fr: 'Délégation refusée',
    it: 'Delega rifiutata',
  },
  'delegation.declined.body': {
    de: 'Deine Schreiber-Delegation wurde abgelehnt',
    gsw: 'Dini Schryber-Delegation isch abglehnt worde',
    en: 'Your scorer delegation was declined',
    fr: 'Ta délégation de marqueur a été refusée',
    it: 'La tua delega di segnapunti è stata rifiutata',
  },
  'eventInvite.body': {
    de: 'Du wurdest eingeladen',
    gsw: 'Du bisch yyglade',
    en: 'You were invited',
    fr: 'Tu as été invité·e',
    it: 'Sei stato invitato',
  },
  'absence.created.title': {
    de: 'Absenz für dich eingetragen',
    gsw: 'Absenz für di iigtreit',
    en: 'Absence added for you',
    fr: 'Absence ajoutée pour toi',
    it: 'Assenza aggiunta per te',
  },
  'absence.created.body': {
    de: '{editor} hat eine Absenz für dich eingetragen (ab {start})',
    gsw: '{editor} het e Absenz für di iigtreit (ab {start})',
    en: '{editor} added an absence for you (from {start})',
    fr: '{editor} a ajouté une absence pour toi (à partir du {start})',
    it: '{editor} ha aggiunto un’assenza per te (dal {start})',
  },
  'absence.updated.title': {
    de: 'Absenz angepasst',
    gsw: 'Absenz aapasst',
    en: 'Absence updated',
    fr: 'Absence modifiée',
    it: 'Assenza modificata',
  },
  'absence.updated.body': {
    de: '{editor} hat deine Absenz angepasst (ab {start})',
    gsw: '{editor} het dini Absenz aapasst (ab {start})',
    en: '{editor} updated your absence (from {start})',
    fr: '{editor} a modifié ton absence (à partir du {start})',
    it: '{editor} ha modificato la tua assenza (dal {start})',
  },
  'absence.weekly.created.title': {
    de: 'Wöchentliche Verhinderung eingetragen',
    gsw: 'Wuchetlichi Verhinderig iigtreit',
    en: 'Weekly unavailability added',
    fr: 'Indisponibilité hebdomadaire ajoutée',
    it: 'Indisponibilità settimanale aggiunta',
  },
  'absence.weekly.created.body': {
    de: '{editor} hat eine wöchentliche Verhinderung für dich eingetragen',
    gsw: '{editor} het e wuchetlichi Verhinderig für di iigtreit',
    en: '{editor} added a weekly unavailability for you',
    fr: '{editor} a ajouté une indisponibilité hebdomadaire pour toi',
    it: '{editor} ha aggiunto un’indisponibilità settimanale per te',
  },
  'absence.weekly.updated.title': {
    de: 'Wöchentliche Verhinderung angepasst',
    gsw: 'Wuchetlichi Verhinderig aapasst',
    en: 'Weekly unavailability updated',
    fr: 'Indisponibilité hebdomadaire modifiée',
    it: 'Indisponibilità settimanale modificata',
  },
  'absence.weekly.updated.body': {
    de: '{editor} hat deine wöchentliche Verhinderung angepasst',
    gsw: '{editor} het dini wuchetlichi Verhinderig aapasst',
    en: '{editor} updated your weekly unavailability',
    fr: '{editor} a modifié ton indisponibilité hebdomadaire',
    it: '{editor} ha modificato la tua indisponibilità settimanale',
  },
  'message.generic': {
    de: 'Neue Nachricht in KSCW',
    gsw: 'Neui Nachricht i KSCW',
    en: 'New message in KSCW',
    fr: 'Nouveau message sur KSCW',
    it: 'Nuovo messaggio in KSCW',
  },
  'trainingCancelled.title': {
    de: 'Training abgesagt',
    gsw: 'Training abgseit',
    en: 'Training cancelled',
    fr: 'Entraînement annulé',
    it: 'Allenamento annullato',
  },
  'trainingCancelled.body': {
    de: '{team}-Training am {date} wurde abgesagt',
    gsw: '{team}-Training am {date} isch abgseit worde',
    en: '{team} training on {date} was cancelled',
    fr: 'L’entraînement {team} du {date} a été annulé',
    it: 'L’allenamento {team} del {date} è stato annullato',
  },
  // Game guest invitation (migration 271) — a coach opened one of their games to
  // another team or to this player individually. {team} = the inviting team's name,
  // {matchup} = "Home - Away", {date} = dd.mm.yyyy.
  'gameInvite.title': {
    de: 'Für ein Spiel aufgeboten',
    gsw: 'Für es Spiel ufbotte',
    en: 'Called up for a game',
    fr: 'Convoqué pour un match',
    it: 'Convocato per una partita',
  },
  'gameInvite.body': {
    de: '{team} bittet dich um Aushilfe: {matchup} am {date}',
    gsw: '{team} bruucht di als Ushilf: {matchup} am {date}',
    en: '{team} would like you to fill in: {matchup} on {date}',
    fr: '{team} souhaite que tu dépannes : {matchup} le {date}',
    it: '{team} ti chiede di dare una mano: {matchup} il {date}',
  },
  // Fines (migration 069) — leader-issued by coach/TR, member is the recipient.
  // {team} = team name, {amount} = "CHF 5.00" (preformatted by caller),
  // {reason} = short freeform from the leader (already trimmed/escaped).
  'fineIssued.title': {
    de: 'Neue Busse',
    gsw: 'Neui Bueß',
    en: 'New fine',
    fr: 'Nouvelle amende',
    it: 'Nuova multa',
  },
  'fineIssued.body': {
    de: '{team} • {amount}: {reason}',
    gsw: '{team} • {amount}: {reason}',
    en: '{team} • {amount}: {reason}',
    fr: '{team} • {amount} : {reason}',
    it: '{team} • {amount}: {reason}',
  },
  'finePaid.title': {
    de: 'Busse bezahlt',
    gsw: 'Bueß zahlt',
    en: 'Fine paid',
    fr: 'Amende payée',
    it: 'Multa pagata',
  },
  'finePaid.body': {
    de: '{team}: {amount} als bezahlt markiert',
    gsw: '{team}: {amount} als zahlt markiert',
    en: '{team}: {amount} marked as paid',
    fr: '{team} : {amount} marqué comme payé',
    it: '{team}: {amount} segnato come pagato',
  },
  'fineWaived.title': {
    de: 'Busse erlassen',
    gsw: 'Bueß erlah',
    en: 'Fine waived',
    fr: 'Amende annulée',
    it: 'Multa annullata',
  },
  'fineWaived.body': {
    de: '{team}: {amount} wurde erlassen',
    gsw: '{team}: {amount} isch erlah worde',
    en: '{team}: {amount} was waived',
    fr: '{team} : {amount} a été annulée',
    it: '{team}: {amount} è stata annullata',
  },
  // Team-level fines (migration 350) — owed by the Teamkasse, so the whole team
  // (players AND staff) is the recipient. {team} = team name, {amount} =
  // preformatted, {reason} = short freeform from the leader.
  'teamFineIssued.title': {
    de: 'Neue Teambusse',
    gsw: 'Neui Teambueß',
    en: 'New team fine',
    fr: 'Nouvelle amende d\'équipe',
    it: 'Nuova multa di squadra',
  },
  'teamFineIssued.body': {
    de: '{team} • {amount}: {reason}',
    gsw: '{team} • {amount}: {reason}',
    en: '{team} • {amount}: {reason}',
    fr: '{team} • {amount} : {reason}',
    it: '{team} • {amount}: {reason}',
  },
  'teamFinePaid.title': {
    de: 'Teambusse bezahlt',
    gsw: 'Teambueß zahlt',
    en: 'Team fine paid',
    fr: 'Amende d\'équipe payée',
    it: 'Multa di squadra pagata',
  },
  'teamFinePaid.body': {
    de: '{team}: {amount} als bezahlt markiert',
    gsw: '{team}: {amount} als zahlt markiert',
    en: '{team}: {amount} marked as paid',
    fr: '{team} : {amount} marqué comme payé',
    it: '{team}: {amount} segnato come pagato',
  },
  'teamFineWaived.title': {
    de: 'Teambusse erlassen',
    gsw: 'Teambueß erlah',
    en: 'Team fine waived',
    fr: 'Amende d\'équipe annulée',
    it: 'Multa di squadra annullata',
  },
  'teamFineWaived.body': {
    de: '{team}: {amount} wurde erlassen',
    gsw: '{team}: {amount} isch erlah worde',
    en: '{team}: {amount} was waived',
    fr: '{team} : {amount} a été annulée',
    it: '{team}: {amount} è stata annullata',
  },
  'fineReminder.title': {
    de: 'Offene Busse(n)',
    gsw: 'Offeni Bueße',
    en: 'Open fine(s)',
    fr: 'Amende(s) ouverte(s)',
    it: 'Multa(e) aperta(e)',
  },
  'fineReminder.body': {
    de: 'Du hast {count} offene Busse(n) — total {amount}',
    gsw: 'Du häsch {count} offeni Bueße — total {amount}',
    en: 'You have {count} open fine(s) — total {amount}',
    fr: 'Tu as {count} amende(s) ouverte(s) — total {amount}',
    it: 'Hai {count} multa(e) aperta(e) — totale {amount}',
  },
  // Forms (migrations 086/087) — fired once when a form transitions to open.
  // {title} = form title.
  'formPublished.title': {
    de: 'Neues Formular',
    gsw: 'Neus Formular',
    en: 'New form',
    fr: 'Nouveau formulaire',
    it: 'Nuovo modulo',
  },
  'formPublished.body': {
    de: '{title} — bitte ausfüllen',
    gsw: '{title} — bitte usfülle',
    en: '{title} — please fill in',
    fr: '{title} — merci de remplir',
    it: '{title} — si prega di compilare',
  },
  // Reminder nudge to members who haven't filled the form yet. {title} = form title.
  'formReminder.title': {
    de: 'Erinnerung',
    gsw: 'Erinnerig',
    en: 'Reminder',
    fr: 'Rappel',
    it: 'Promemoria',
  },
  'formReminder.body': {
    de: 'Bitte fülle «{title}» noch aus',
    gsw: 'Bitte füll «{title}» no us',
    en: 'Please still fill in "{title}"',
    fr: 'Merci de remplir ce formulaire : {title}',
    it: 'Si prega di compilare «{title}»',
  },
  // Sent to the form owner (+ co-managers) when a response arrives. {title} = form title.
  'formSubmission.title': {
    de: 'Neue Antwort',
    gsw: 'Neui Antwort',
    en: 'New response',
    fr: 'Nouvelle réponse',
    it: 'Nuova risposta',
  },
  'formSubmission.body': {
    de: 'Neue Antwort auf «{title}»',
    gsw: 'Neui Antwort uf «{title}»',
    en: 'New response to "{title}"',
    fr: 'Nouvelle réponse à « {title} »',
    it: 'Nuova risposta a «{title}»',
  },

  // Licence status (migration 301). {season} = "2026/27".
  //
  // One body per STATE rather than one body with a {status} variable: tPush
  // substitutes the same variable bag into every locale, so a status name
  // passed as a var would arrive in whichever language the sender happened to
  // resolve it in — German push text ending in "Ordered". Spelling the five
  // out is more lines and the only way each locale reads like itself.
  'licenceStatus.title': {
    de: 'Lizenzstatus',
    gsw: 'Lizenzstatus',
    en: 'Licence status',
    fr: 'Statut de licence',
    it: 'Stato della licenza',
  },
  'licenceStatus.body.none': {
    de: 'Für {season} ist keine Lizenz hinterlegt.',
    gsw: 'Für {season} isch kei Lizänz hinterleit.',
    en: 'No licence is on file for {season}.',
    fr: 'Aucune licence enregistrée pour {season}.',
    it: 'Nessuna licenza registrata per {season}.',
  },
  'licenceStatus.body.to_be_ordered': {
    de: 'Deine Lizenz für {season} muss noch bestellt werden.',
    gsw: 'Dini Lizänz für {season} mues no bstellt werde.',
    en: 'Your licence for {season} still has to be ordered.',
    fr: 'Ta licence pour {season} doit encore être commandée.',
    it: 'La tua licenza per {season} deve ancora essere ordinata.',
  },
  'licenceStatus.body.ordered': {
    de: 'Deine Lizenz für {season} ist bestellt.',
    gsw: 'Dini Lizänz für {season} isch bstellt.',
    en: 'Your licence for {season} has been ordered.',
    fr: 'Ta licence pour {season} a été commandée.',
    it: 'La tua licenza per {season} è stata ordinata.',
  },
  'licenceStatus.body.finalized': {
    de: 'Deine Lizenz für {season} ist abgeschlossen — wir warten auf die Bestätigung des Verbands.',
    gsw: 'Dini Lizänz für {season} isch fertig — mir warte uf d Bestätigung vom Verband.',
    en: 'Your licence for {season} is complete — waiting for the federation to confirm.',
    fr: 'Ta licence pour {season} est finalisée — en attente de la confirmation de la fédération.',
    it: 'La tua licenza per {season} è completa — in attesa della conferma della federazione.',
  },
  'licenceStatus.body.licenced': {
    de: 'Deine Lizenz für {season} ist vom Verband bestätigt.',
    gsw: 'Dini Lizänz für {season} isch vom Verband bestätigt.',
    en: 'Your licence for {season} is confirmed by the federation.',
    fr: 'Ta licence pour {season} est confirmée par la fédération.',
    it: 'La tua licenza per {season} è confermata dalla federazione.',
  },
}

/**
 * Look up a translated push string for a locale, with `{name}` / `{team}`
 * variable substitution. Falls back to `de` if the locale is missing.
 */
export function tPush(locale, key, vars = {}) {
  const row = T[key]
  if (!row) return ''
  const code = LOCALES.includes(locale) ? locale : 'de'
  const tpl = row[code] || row.de || ''
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''))
}

/**
 * Convenience helper: bucket recipients and dispatch one push per locale.
 *
 * `sendFn(memberIds, title, body)` is supplied by the caller so this module
 * stays decoupled from the (two) `sendPushToMembers` implementations
 * (kscw-endpoints + kscw-hooks have their own).
 *
 * @param {object} db - knex
 * @param {Array<number|string>} memberIds
 * @param {(ids: any[], title: string, body: string) => Promise<unknown>} sendFn
 * @param {string} titleKey - translation key for the title (or null to use a literal)
 * @param {string} bodyKey - translation key for the body
 * @param {object} vars - variables for both keys
 * @param {string} [literalTitle] - if set, used verbatim in every locale (e.g. user content like an event title or announcement title which is itself already localized)
 */
export async function sendLocalizedPush(db, memberIds, sendFn, titleKey, bodyKey, vars = {}, literalTitle = null) {
  const buckets = await bucketMembersByLocale(db, memberIds)
  for (const code of LOCALES) {
    const ids = buckets[code]
    if (!ids || ids.length === 0) continue
    const title = literalTitle != null ? literalTitle : tPush(code, titleKey, vars)
    const body = tPush(code, bodyKey, vars)
    await sendFn(ids, title, body)
  }
}
