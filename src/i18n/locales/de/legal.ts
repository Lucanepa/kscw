export default {
  // Datenschutz page
  privacyTitle: 'Datenschutzerklärung',
  lastUpdated: 'Stand: 28. Februar 2026',

  controllerTitle: '1. Verantwortliche Stelle',
  controllerText:
    'KSC Wiedikon\nSchrennengasse 7\n8003 Zürich\nE-Mail: vorstand@kscw.ch',

  dataCollectedTitle: '2. Welche Daten wir erheben',
  dataAccountTitle: 'Kontodaten (bei Registrierung)',
  dataAccountText:
    'Bei der Registrierung als Vereinsmitglied erfassen wir: Name, E-Mail-Adresse, Telefonnummer, Geburtsdatum, Foto, Lizenznummer, Trikotnummer und Position.',
  dataRosterTitle: 'Kaderdaten (öffentlich)',
  dataRosterText:
    'Auf den öffentlich zugänglichen Teamseiten werden Name, Trikotnummer, Position und Foto der Spielerinnen und Spieler angezeigt. Diese Angaben entsprechen den Daten, die auch von Swiss Volley öffentlich publiziert werden.',
  dataInternalTitle: 'Interne Vereinsdaten',
  dataInternalText:
    'Trainingsanwesenheiten, Absenzen (inkl. Grund), Schreiberdienst-Einteilungen und Spielresultate werden intern für die Vereinsverwaltung erfasst und sind nur für eingeloggte Mitglieder bzw. Trainer sichtbar.',
  dataTechnicalTitle: 'Technische Daten',
  dataTechnicalText:
    'Beim Besuch der Website werden automatisch technische Informationen wie IP-Adresse und Browser-Informationen durch unseren Hosting-Anbieter (Cloudflare) verarbeitet.',

  legalBasisTitle: '3. Rechtsgrundlagen',
  legalBasisText:
    'Die Verarbeitung personenbezogener Daten erfolgt auf Grundlage von:',
  legalBasisContract:
    'Vertragserfüllung (Vereinsmitgliedschaft) — für die Verwaltung von Mitgliederdaten, Trainings und Spielplanung.',
  legalBasisInterest:
    'Berechtigtes Interesse — für die öffentliche Darstellung von Teamkadern, wie es im Vereinssport üblich und von den Mitgliedern erwartet wird.',
  legalBasisConsent:
    'Einwilligung — für die Veröffentlichung von Fotos auf der Website.',

  thirdPartyTitle: '4. Drittanbieter',
  thirdPartyCloudflare:
    'Cloudflare, Inc. — Hosting und CDN der Website. Cloudflare kann technisch notwendige Cookies setzen (z.B. __cf_bm). Cloudflare verfügt über EU-Standardvertragsklauseln.',
  thirdPartySwissVolley:
    'Swiss Volley API (api.volleyball.ch) — Wir rufen öffentlich verfügbare Spieldaten und Ranglisten ab. Es werden keine personenbezogenen Daten an Swiss Volley übermittelt.',
  thirdPartyGCal:
    'Google Calendar — Wir rufen einen öffentlichen Kalender-Feed ab, um Hallenbelegungen anzuzeigen. Es werden keine personenbezogenen Daten an Google übermittelt.',

  storageTitle: '5. Datenspeicherung',
  storageServer:
    'Die Daten werden auf einem selbst betriebenen Server in der Schweiz gespeichert (PocketBase). Das Frontend wird über Cloudflare Pages bereitgestellt.',
  storageLocal:
    'Im Browser werden folgende nicht-personenbezogene Einstellungen gespeichert: Farbschema (hell/dunkel) und Spracheinstellung. Für eingeloggte Nutzer wird ein Sitzungs-Token im Browser gespeichert.',
  storageNoCookies:
    'Die Website selbst setzt keine Cookies. Cloudflare kann technisch notwendige Cookies setzen, die keiner Einwilligung bedürfen.',

  rightsTitle: '6. Ihre Rechte',
  rightsText:
    'Gemäss dem Schweizer Datenschutzgesetz (nDSG) haben Sie folgende Rechte:',
  rightsAccess: 'Auskunftsrecht — Sie können Auskunft über Ihre gespeicherten Daten verlangen.',
  rightsCorrection: 'Berichtigungsrecht — Sie können die Berichtigung unrichtiger Daten verlangen.',
  rightsDeletion: 'Recht auf Löschung — Sie können die Löschung Ihrer Daten verlangen.',
  rightsPortability: 'Recht auf Datenherausgabe — Sie können Ihre Daten in einem gängigen Format erhalten.',
  rightsContact:
    'Für Anfragen zu Ihren Rechten wenden Sie sich bitte an: vorstand@kscw.ch',

  photosTitle: '7. Fotos',
  photosText:
    'Team- und Spielerfotos werden von Trainern oder dem Vorstand hochgeladen. Wenn Sie die Entfernung Ihres Fotos wünschen, wenden Sie sich an den Vorstand.',

  changesTitle: '8. Änderungen',
  changesText:
    'Wir behalten uns vor, diese Datenschutzerklärung bei Bedarf anzupassen. Die aktuelle Version ist auf dieser Seite verfügbar.',

  // Impressum page
  impressumTitle: 'Impressum',
  impressumClubName: 'KSC Wiedikon',
  impressumAddress: 'Schrennengasse 7\n8003 Zürich',
  impressumContact: 'E-Mail: vorstand@kscw.ch',
  impressumBoard: 'Verantwortlich: Vorstand KSC Wiedikon',
  impressumHosting: 'Hosting: Cloudflare Pages (Frontend), selbst gehosteter Server in der Schweiz (Backend)',
  impressumSocial: 'Social Media',
  impressumFacebook: 'Facebook: KSC Wiedikon',
  impressumInstagram: 'Instagram: @ksc_wiedikon',
  impressumDisclaimer: 'Haftungsausschluss',
  impressumDisclaimerText:
    'Der KSC Wiedikon übernimmt keine Gewähr für die Richtigkeit, Vollständigkeit und Aktualität der bereitgestellten Informationen. Haftungsansprüche gegen den KSC Wiedikon, die sich auf Schäden materieller oder ideeller Art beziehen, sind grundsätzlich ausgeschlossen.',
} as const
