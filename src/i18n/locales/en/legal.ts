export default {
  // Privacy Policy page
  privacyTitle: 'Privacy Policy',
  lastUpdated: 'Last updated: February 28, 2026',

  controllerTitle: '1. Data Controller',
  controllerText:
    'KSC Wiedikon\nSchrennengasse 7\n8003 Zürich\nEmail: vorstand@kscw.ch',

  dataCollectedTitle: '2. Data We Collect',
  dataAccountTitle: 'Account data (upon registration)',
  dataAccountText:
    'When registering as a club member, we collect: name, email address, phone number, date of birth, photo, license number, jersey number, and position.',
  dataRosterTitle: 'Roster data (public)',
  dataRosterText:
    'On the publicly accessible team pages, player names, jersey numbers, positions, and photos are displayed. This information corresponds to data also published publicly by Swiss Volley.',
  dataInternalTitle: 'Internal club data',
  dataInternalText:
    'Training attendance, absences (including reason), scorer duty assignments, and game results are recorded internally for club management and are only visible to logged-in members or coaches.',
  dataTechnicalTitle: 'Technical data',
  dataTechnicalText:
    'When visiting the website, technical information such as IP address and browser information is automatically processed by our hosting provider (Cloudflare).',

  legalBasisTitle: '3. Legal Basis',
  legalBasisText:
    'The processing of personal data is based on:',
  legalBasisContract:
    'Contract fulfillment (club membership) — for managing member data, training, and game planning.',
  legalBasisInterest:
    'Legitimate interest — for the public display of team rosters, as is customary in club sports and expected by members.',
  legalBasisConsent:
    'Consent — for the publication of photos on the website.',

  thirdPartyTitle: '4. Third-Party Services',
  thirdPartyCloudflare:
    'Cloudflare, Inc. — Website hosting and CDN. Cloudflare may set technically necessary cookies (e.g., __cf_bm). Cloudflare maintains EU Standard Contractual Clauses.',
  thirdPartySwissVolley:
    'Swiss Volley API (api.volleyball.ch) — We retrieve publicly available game data and rankings. No personal data is transmitted to Swiss Volley.',
  thirdPartyGCal:
    'Google Calendar — We retrieve a public calendar feed to display hall schedules. No personal data is transmitted to Google.',

  storageTitle: '5. Data Storage',
  storageServer:
    'Data is stored on a self-hosted server in Switzerland (PocketBase). The frontend is served via Cloudflare Pages.',
  storageLocal:
    'The following non-personal preferences are stored in your browser: color scheme (light/dark) and language setting. For logged-in users, a session token is stored in the browser.',
  storageNoCookies:
    'The website itself does not set any cookies. Cloudflare may set technically necessary cookies that do not require consent.',

  rightsTitle: '6. Your Rights',
  rightsText:
    'Under the Swiss Data Protection Act (nDSG), you have the following rights:',
  rightsAccess: 'Right of access — You can request information about your stored data.',
  rightsCorrection: 'Right to rectification — You can request the correction of inaccurate data.',
  rightsDeletion: 'Right to deletion — You can request the deletion of your data.',
  rightsPortability: 'Right to data portability — You can receive your data in a common format.',
  rightsContact:
    'For requests regarding your rights, please contact: vorstand@kscw.ch',

  photosTitle: '7. Photos',
  photosText:
    'Team and player photos are uploaded by coaches or the board. If you wish to have your photo removed, please contact the board.',

  changesTitle: '8. Changes',
  changesText:
    'We reserve the right to update this privacy policy as needed. The current version is available on this page.',

  // Impressum page
  impressumTitle: 'Legal Notice',
  impressumClubName: 'KSC Wiedikon',
  impressumAddress: 'Schrennengasse 7\n8003 Zürich',
  impressumContact: 'Email: vorstand@kscw.ch',
  impressumBoard: 'Responsible: Board of KSC Wiedikon',
  impressumHosting: 'Hosting: Cloudflare Pages (frontend), self-hosted server in Switzerland (backend)',
  impressumSocial: 'Social Media',
  impressumFacebook: 'Facebook: KSC Wiedikon',
  impressumInstagram: 'Instagram: @ksc_wiedikon',
  impressumDisclaimer: 'Disclaimer',
  impressumDisclaimerText:
    'KSC Wiedikon assumes no liability for the accuracy, completeness, or timeliness of the information provided. Liability claims against KSC Wiedikon relating to material or immaterial damages are generally excluded.',
} as const
