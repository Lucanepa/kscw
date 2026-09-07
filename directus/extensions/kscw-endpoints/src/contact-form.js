/**
 * Contact Form
 * POST /kscw/contact — public, Turnstile protected
 */

import { bucketEmailsByLocale } from './email-template.js'

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || ''

const T = {
  de: {
    subject: (subj, name) => `[KSCW Kontakt] ${subj || 'Anfrage'} von ${name}`,
    teamSubject: (team) => `Kontakt ${team}`,
    nameLabel: 'Name', emailLabel: 'E-Mail', subjectLabel: 'Betreff',
  },
  gsw: {
    subject: (subj, name) => `[KSCW Kontakt] ${subj || 'Aafrog'} vo ${name}`,
    teamSubject: (team) => `Kontakt ${team}`,
    nameLabel: 'Name', emailLabel: 'E-Mail', subjectLabel: 'Betreff',
  },
  en: {
    subject: (subj, name) => `[KSCW Contact] ${subj || 'Inquiry'} from ${name}`,
    teamSubject: (team) => `Contact ${team}`,
    nameLabel: 'Name', emailLabel: 'Email', subjectLabel: 'Subject',
  },
  fr: {
    subject: (subj, name) => `[KSCW Contact] ${subj || 'Demande'} de ${name}`,
    teamSubject: (team) => `Contact ${team}`,
    nameLabel: 'Nom', emailLabel: 'E-mail', subjectLabel: 'Objet',
  },
  it: {
    subject: (subj, name) => `[KSCW Contatto] ${subj || 'Richiesta'} da ${name}`,
    teamSubject: (team) => `Contatto ${team}`,
    nameLabel: 'Nome', emailLabel: 'E-mail', subjectLabel: 'Oggetto',
  },
}

const CF_LOCALES = ['de', 'gsw', 'en', 'fr', 'it']

// Auto-reply sent to the sender's own email after submission. Intentionally
// contains zero recipient information — exposing the team mailbox would
// defeat the privacy of the contact flow.
const ACK_BODY = {
  de: (name) => `Hallo ${name},\n\nDanke für deine Nachricht an den KSC Wiedikon. Wir melden uns so bald wie möglich bei dir.\n\nKopie deiner Nachricht:\n— — — — — — — — — —\n`,
  gsw: (name) => `Sali ${name},\n\nDanke für dini Nachricht ans KSC Wiedikon. Mer mälde üs so schnell wie möglich.\n\nKopie vo dinere Nachricht:\n— — — — — — — — — —\n`,
  en: (name) => `Hi ${name},\n\nThanks for reaching out to KSC Wiedikon. We'll get back to you as soon as possible.\n\nA copy of your message:\n— — — — — — — — — —\n`,
  fr: (name) => `Bonjour ${name},\n\nMerci pour ton message au KSC Wiedikon. Nous te répondrons dès que possible.\n\nCopie de ton message :\n— — — — — — — — — —\n`,
  it: (name) => `Ciao ${name},\n\nGrazie per il tuo messaggio a KSC Wiedikon. Ti risponderemo il prima possibile.\n\nCopia del tuo messaggio:\n— — — — — — — — — —\n`,
}
const ACK_OUTRO = {
  de: '\n— — — — — — — — — —\n\nSportliche Grüsse\nKSC Wiedikon',
  gsw: '\n— — — — — — — — — —\n\nSportlichi Grüess\nKSC Wiedikon',
  en: '\n— — — — — — — — — —\n\nBest regards\nKSC Wiedikon',
  fr: '\n— — — — — — — — — —\n\nMeilleures salutations\nKSC Wiedikon',
  it: '\n— — — — — — — — — —\n\nCordiali saluti\nKSC Wiedikon',
}

const SPORT_EMAILS = {
  volleyball: process.env.CONTACT_EMAIL_VB || 'volleyball@kscw.ch',
  basketball: process.env.CONTACT_EMAIL_BB || 'basketball@kscw.ch',
}
const GENERAL_EMAIL = process.env.CONTACT_EMAIL_GENERAL || 'kontakt@kscw.ch'

// Basketball youth (U-)teams route to the dedicated youth coordinator instead
// of the team's coaches/responsibles or the basketball@ alias.
const BB_YOUTH_EMAIL = process.env.CONTACT_EMAIL_BB_YOUTH || 'anne.grimshaw@kscw.ch'

// Youth team names carry a "U<number>" token (HU18, DU16, MU8 …). Same heuristic
// used for junior detection in game-scheduling.js.
const isYouthTeam = (name) => /u\d/i.test(String(name || ''))

// The club-wide basketball-youth waiting list — the one form every full youth
// team points at. Mirrors DEFAULT_WAITLIST_URL in the kscw-website repo
// (src/lib/fetch/youthBasketball.ts, public/js/youth-status.js,
// public/js/contact-form.js).
const DEFAULT_WAITLIST_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSfvak-SELFox7Bv2RVLrjA_uZ2K6vTiKYgRheDtck92VH8crQ/viewform'

async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) {
    console.error('[contact-form] TURNSTILE_SECRET not configured — rejecting request')
    return false
  }
  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token || '') }).toString(),
  })
  return (await resp.json()).success === true
}

// ── Anti-abuse (2026-06-25 audit INT-1) ──────────────────────────────────
// /contact is public + Turnstile-only; a per-IP limiter stops a solved or
// misconfigured Turnstile from turning KSCW's DKIM-aligned sender into an
// email-bomb / staff-spam relay. Safe ONLY behind CF Tunnel (see SECURITY.md).
const contactIpAttempts = new Map()
function contactRateLimit(req, maxAttempts, windowMs) {
  const xff = req.headers['x-forwarded-for']
  const ip = req.headers['cf-connecting-ip']
    || (typeof xff === 'string' ? xff.split(',')[0].trim() : '')
    || req.ip || 'unknown'
  const now = Date.now()
  const a = contactIpAttempts.get(ip)
  if (a && now < a.resetAt) {
    if (a.count >= maxAttempts) return false
    a.count++
  } else {
    contactIpAttempts.set(ip, { count: 1, resetAt: now + windowMs })
  }
  if (contactIpAttempts.size > 1000) {
    for (const [k, v] of contactIpAttempts) { if (now > v.resetAt) contactIpAttempts.delete(k) }
  }
  return true
}

// Fixed sender-acknowledgement — never echo the sender-supplied message/subject
// back to the UNVERIFIED, attacker-choosable recipient address. Echoing the
// free-form message there made /contact an arbitrary-text-to-arbitrary-recipient
// relay under KSCW's domain reputation (audit INT-1). Send a constant ack.
const ACK_SUBJECT = {
  de: 'Deine Nachricht an den KSC Wiedikon',
  gsw: 'Dini Nachricht ans KSC Wiedikon',
  en: 'Your message to KSC Wiedikon',
  fr: 'Ton message au KSC Wiedikon',
  it: 'Il tuo messaggio a KSC Wiedikon',
}
const ACK_CONFIRM = {
  de: (name) => `Hallo ${name},\n\nDanke für deine Nachricht an den KSC Wiedikon. Wir melden uns so bald wie möglich bei dir.\n\nSportliche Grüsse\nKSC Wiedikon`,
  gsw: (name) => `Sali ${name},\n\nDanke für dini Nachricht ans KSC Wiedikon. Mer mälde üs so schnell wie möglich.\n\nSportlechi Grüess\nKSC Wiedikon`,
  en: (name) => `Hi ${name},\n\nThanks for reaching out to KSC Wiedikon. We'll get back to you as soon as possible.\n\nBest regards\nKSC Wiedikon`,
  fr: (name) => `Bonjour ${name},\n\nMerci pour ton message au KSC Wiedikon. Nous te répondrons dès que possible.\n\nMeilleures salutations\nKSC Wiedikon`,
  it: (name) => `Ciao ${name},\n\nGrazie per il tuo messaggio a KSC Wiedikon. Ti risponderemo il prima possibile.\n\nCordiali saluti\nKSC Wiedikon`,
}

export function registerContactForm(router, { database, logger, services, getSchema }) {
  const log = logger.child({ endpoint: 'contact-form' })

  router.post('/contact', async (req, res) => {
    try {
      const { name: rawName, email, subject: rawSubject, message, team_id, sport, turnstile_token, locale: rawLocale } = req.body
      const senderLocale = CF_LOCALES.includes(rawLocale) ? rawLocale : 'de'
      if (!rawName || !email || !message) {
        return res.status(400).json({ error: 'name, email, message required' })
      }
      // Strip control characters to prevent email header injection
      const name = String(rawName).replace(/[\r\n\t]/g, '')
      const subject = rawSubject ? String(rawSubject).replace(/[\r\n\t]/g, '') : ''
      // Validate email format (reject control characters)
      if (/[\r\n\t]/.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' })
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' })
      }

      if (!contactRateLimit(req, 5, 10 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' })
      }

      if (!turnstile_token || !(await verifyTurnstile(turnstile_token))) {
        return res.status(400).json({ error: 'Captcha verification failed' })
      }

      // Determine recipient — M2M: teams_coaches/teams_responsibles
      // (teams_id, members_id) join → members.email
      let toEmail = GENERAL_EMAIL
      let teamName = null
      if (team_id) {
        const [coaches, trs, teamRow] = await Promise.all([
          database('teams_coaches')
            .join('members', 'members.id', 'teams_coaches.members_id')
            .where('teams_coaches.teams_id', team_id)
            .whereNotNull('members.email')
            .select('members.email'),
          database('teams_responsibles')
            .join('members', 'members.id', 'teams_responsibles.members_id')
            .where('teams_responsibles.teams_id', team_id)
            .whereNotNull('members.email')
            .select('members.email'),
          database('teams').where('id', team_id).first('id', 'full_name', 'name', 'sport', 'open_for_players'),
        ])
        if (teamRow) teamName = teamRow.full_name || teamRow.name || null

        // A FULL team must not receive contact mail it can only answer with no.
        // The website hides the team's contact button and drops the team from the
        // form's dropdown entirely, but /contact is public: a cached page, a
        // bookmark or a direct POST all still arrive here, so the rejection has to
        // live on this side too.
        //
        // "Full" is open_for_players === false, NOT a non-empty waitlist_url as
        // before. That column doubled as the flag and outranked open_for_players,
        // so a coach who reopened a team stayed blocked here (DU12, 2026-08-18);
        // every value in it was the same club-wide form, and it has been cleared.
        //
        // Two rejections, because only one of them has somewhere to send the
        // sender next:
        //   • closed BASKETBALL YOUTH → 'team_full' + the club-wide waiting list,
        //     which is the real next step for a family whose age group is full.
        //   • any other full team → 'team_closed', with no waiting list named: a
        //     volleyball enquiry pointed at a basketball youth form is nonsense.
        //
        // This widened on 2026-09-07. It was youth-only before, on the grounds
        // that senior and volleyball teams at open_for_players=false were merely
        // "not recruiting" and had to stay contactable — the website now treats
        // that flag as full everywhere, so the two sides agree again.
        const isFull = !!teamRow && teamRow.open_for_players === false
        const isClosedYouth = isFull
          && teamRow.sport === 'basketball'
          && isYouthTeam(teamRow.name)
        if (isClosedYouth) {
          return res.status(409).json({
            error: 'team_full',
            waitlist_url: DEFAULT_WAITLIST_URL,
            waitlist_label: null,
          })
        }
        if (isFull) {
          return res.status(409).json({ error: 'team_closed' })
        }

        if (teamRow && teamRow.sport === 'basketball' && isYouthTeam(teamRow.name)) {
          // Basketball youth teams: always the youth coordinator, never the
          // coaches/responsibles or the basketball@ alias.
          toEmail = BB_YOUTH_EMAIL
        } else {
          const recipients = [...coaches, ...trs]
            .map(r => r.email).filter(e => e && !e.includes('@placeholder'))
          // Dedupe — a member may be both coach and TR on the same team
          const unique = Array.from(new Set(recipients))
          if (unique.length > 0) toEmail = unique.join(',')
          else if (sport && SPORT_EMAILS[sport]) toEmail = SPORT_EMAILS[sport]
        }
      } else if (sport && SPORT_EMAILS[sport]) {
        toEmail = SPORT_EMAILS[sport]
      }

      const schema = await getSchema()
      const { MailService } = services
      const mail = new MailService({ schema, knex: database })

      // Per-recipient locale: members get their preferred language, alias
      // addresses (kontakt@/volleyball@/basketball@) fall back to DE.
      const recipientList = toEmail.split(',').map(s => s.trim()).filter(Boolean)
      const buckets = await bucketEmailsByLocale(database, recipientList)
      for (const loc of CF_LOCALES) {
        const tos = buckets[loc]
        if (!tos.length) continue
        const tt = T[loc] || T.de
        // For team contacts, use the sender's locale for the subject so the
        // user-facing line matches the page they sent from ("Contact H1" /
        // "Kontakt H1"). The body still translates per recipient preference.
        const senderTT = T[senderLocale] || T.de
        const mailSubject = (team_id && teamName)
          ? senderTT.teamSubject(teamName)
          : tt.subject(subject, name)
        await mail.send({
          to: tos.join(','),
          subject: mailSubject,
          text: `${tt.nameLabel}: ${name}\n${tt.emailLabel}: ${email}\n${tt.subjectLabel}: ${subject || '-'}\n\n${message}`,
        })
      }

      // Separate confirmation to the sender. Constant body/subject only — the
      // recipient is the unverified, sender-supplied address, so we must NOT
      // echo the free-form message/subject back to it (audit INT-1).
      try {
        await mail.send({
          to: email,
          subject: ACK_SUBJECT[senderLocale] || ACK_SUBJECT.de,
          text: (ACK_CONFIRM[senderLocale] || ACK_CONFIRM.de)(name),
        })
      } catch (ackErr) {
        // Confirmation failure shouldn't fail the whole request — the real
        // message already reached the team. Log and continue.
        log.warn({ msg: `contact: ack mail failed: ${ackErr.message}` })
      }

      log.info(`Contact form sent to team ${team_id} contact`)
      res.json({ success: true })
    } catch (err) {
      log.error({
        msg: `contact: ${err.message}`,
        endpoint: 'contact',
        method: req.method,
        body: { team_id: req.body?.team_id, sport: req.body?.sport },
        stack: err.stack,
      })
      res.status(500).json({ error: 'Internal error' })
    }
  })
}
