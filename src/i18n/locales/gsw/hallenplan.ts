export default {
  title: 'Halleplan',
  subtitleDay: 'Tagesaasicht vo de Hallebelegig',
  subtitleWeek: 'Wuchenaasicht vo de Hallebelegig',

  // Slot form
  hall: 'Halle',
  team: 'Team',
  searchTeam: 'Team sueche…',
  noTeamFound: 'Käis Team gfunde.',
  freeSlot: 'Freie Trainingsslot',
  freeSlotHint: 'Käis Team zuegwise — für jedes Team zum Beaaspruche freigeh',
  dayOfWeek: 'Wuchetag',
  slotType: 'Typ',
  startTime: 'Startzit',
  endTime: 'Ändzit',
  recurring: 'Wiederkehrend',
  validFrom: 'Gültig ab',
  validTo: 'Gültig bis',
  indefinitely: 'Unbefristet',
  label: 'Bezeichnig',
  autoLabel: 'Automatischi Bezeichnig',
  notes: 'Notize',

  // Slot types
  typeTraining: 'Training',
  typeGame: 'Spiel',
  typeEvent: 'Event',
  typeOther: 'Anderi',

  // Day names (full)
  dayMonday: 'Mäntig',
  dayTuesday: 'Ziischtig',
  dayWednesday: 'Mittwuch',
  dayThursday: 'Dunschtig',
  dayFriday: 'Friitig',
  daySaturday: 'Samschtig',
  daySunday: 'Sunntig',

  // Slot editor
  editSlot: 'Slot bearbeite',
  editSlotTitle: 'Slot bearbeite',
  newSlotTitle: 'Neue Slot',
  deleteSlotConfirm: 'Bisch sicher, dass du de Slot lösche wotsch?',
  selectPlaceholder: '-- Uswähle --',

  // Validation
  hallRequired: 'Bitte wähl e Halle',
  dayRequired: 'Bitte wähl en Tag',
  startTimeRequired: 'Startzit bruuchts',
  endTimeRequired: 'Ändzit bruuchts',

  // Closure manager
  closuresTitle: 'Hallesperrige verwalte',
  currentClosures: 'Aktuelli Sperrige',
  addNewClosure: 'Neui Sperrig',
  editClosure: 'Sperrig bearbeite',
  noClosures: 'Käni aktive Sperrige',
  deleteClosureConfirm: 'Bisch sicher, dass du die Hallesperrig lösche wotsch?',
  closuresSubtitle: 'Täg, wo e Halle zue isch. E Sperrig blendet d Halle im Hallenplan us, chunnt im Kalender und im iCal-Feed vor, sperrt det Heimspiel und seit Trainings a dene Täg ab.',
  closuresScopeUpcoming: 'Chunnt no',
  closuresScopeAll: 'Alli',
  closuresColDates: 'Date',
  closureAddedToast_one: 'Sperrig hinzuegfüegt: {{range}}, 1 Halle',
  closureAddedToast_other: 'Sperrig hinzuegfüegt: {{range}}, {{count}} Halle',
  closureUpdatedToast_one: 'Sperrig aktualisiert: {{range}}, 1 Halle',
  closureUpdatedToast_other: 'Sperrig aktualisiert: {{range}}, {{count}} Halle',
  closureDeletedToast: 'Sperrig glöscht',
  closureSyncOwnedWarning: 'Die Quelle wird vomene automatische Sync verwaltet — e Sperrig, wo du da speichersch, wird bim nächste Lauf wieder glöscht. Nimm «Admin» oder «Hauswart» für e manuelli Sperrig.',

  // Hall-administration calendar (gcal) — per-entry closure override
  gcalEntriesTitle: 'Kalender vo de Hallenverwaltig',
  gcalEntriesSubtitle: 'Jede Iitrag, wo d Hallenverwaltig i dä Kalender stellt, sperrt d KWI-Halle. Isch en Iitrag kei echti Sperrig — zum Bispil es sälber iitreits Spiel oder Training vom Verein —, chasch en da abschalte; abgseiti Trainings sind denn wieder aktiv.',
  gcalEntriesEmpty: 'Kei aastehendi Iiträg vo de Hallenverwaltig',
  gcalColEntry: 'Iitrag',
  gcalColEffect: 'Wirkig',
  gcalEffectCloses: 'Sperrt d Halle',
  gcalEffectOpen: 'Kei Sperrig',
  gcalEffectConfirmed: 'Sperrt d Halle (bestätigt)',
  gcalActionOpen: 'Kei Sperrig',
  gcalActionClose: 'Halle sperre',
  gcalCloseConfirm: 'KWI-Halle für dä Iitrag sperre? Trainings a dene Täg werded abgseit.',
  gcalOverrideOffToast: 'Kei Sperrig meh',
  gcalOverrideOnToast: 'Halle gsperrt',
  gcalTrainingsCancelledToast_one: '1 Training abgseit',
  gcalTrainingsCancelledToast_other: '{{count}} Trainings abgseit',
  gcalTrainingsRestoredToast_one: '1 Training isch wieder aktiv',
  gcalTrainingsRestoredToast_other: '{{count}} Trainings sind wieder aktiv',

  // Publishing a club closure to the hall administration's calendar
  gcalPushCol: 'Hallechalender',
  gcalPushNo: 'Nöd publiziert',
  gcalPushYes: 'Publiziert',
  gcalPushDuplicate: 'Scho erfasst',
  gcalPushNotEligible: '—',
  gcalPushAction: 'Publiziere',
  gcalPushRemoveAction: 'Entferne',
  gcalPushConfirm: 'Die Sperrig im Chalender vo de Hallenverwaltig publiziere? Si gsehnd si als KSCW-Belegig.',
  gcalPushRemoveConfirm: 'Die Sperrig us em Chalender vo de Hallenverwaltig entferne?',
  gcalPushedToast: 'Im Hallechalender publiziert',
  gcalPushRemovedToast: 'Us em Hallechalender entfernt',
  gcalPushDuplicateToast: 'Nöd publiziert — d Hallenverwaltig hät dä Zitruum scho erfasst ({{title}})',
  gcalPushDryRunToast: 'Zum Publiziere markiert (Dev laufft trocke — nüt gschriebe)',
  gcalPushDisabledToast: 'Markiert, aber de Chalender-Push isch uf dere Umgebig nöd konfiguriert',



  // Closure sources
  source: 'Quelle',
  sourceCaretaker: 'Huuswart',
  sourceAdmin: 'Admin',
  sourceAutomatic: 'Automatisch',
  sourceGcal: 'Google Kaländer',
  sourceSchoolHolidays: 'Schuelferie',
  closed: 'Gsperrt',
  allHalls: 'Alli Halle',
  halls: 'Halle',
  editAppliesToAllHalls: 'Änderig gilt für {{count}} Halle',
  hallsField: 'Halle',
  selectHallsHint: 'Ei oder mehreri Halle uswähle',
  presetKwi: 'KWI',

  // Navigation
  today: 'Hüt',
  closures: 'Sperrige',
  prevWeek: 'Vorhärigi Wuche',
  nextWeek: 'Nöchscht Wuche',

  // Summary
  summary: 'Übersicht',

  // Virtual slots
  typeAway: 'Uswärts',
  autoGenerated: 'Automatisch generiert',
  cancelled: 'Abgseit',

  // Virtual slot detail labels
  league: 'Liga',
  start: 'Start',
  slot: 'Slot',
  result: 'Ergebnis',
  location: 'Ort',
  allDay: 'De ganz Tag',
  date: 'Datum',
  reason: 'Grund',

  // Game statuses
  statusScheduled: 'Geplant',
  statusLive: 'Live',
  statusCompleted: 'Abgschlosse',
  statusPostponed: 'Verschobe',

  // Claim system
  slotFreed: 'Frei',
  slotClaimed: 'Beansprucht',
  claimSlotTitle: 'Hallezit beanspruche',
  claimConfirm: 'Beanspruche',
  claimRelease: 'Freigäh',
  claimReleaseConfirm: 'Bisch sicher, dass du die Beanspruchig ufhebe wotsch?',
  claimAlreadyTaken: 'De Slot isch scho beansprucht worde.',
  claimPastDate: 'Vergangeni Slots chönd nöd beansprucht werde.',
  claimTeamLabel: 'Für Team',
  claimReasonCancelled: 'Training abgseit',
  claimReasonAway: 'Uswärtsspiel',
  claimReasonSpielhalle: 'Spielhalle',
  claimOriginalTeam: 'Ursprünglich',
  claimClaimedBy: 'Beansprucht vo',
  claimClaimedAt: 'Beansprucht am',
  claimNotes: 'Notize',
  claimSuccess: 'Slot erfolgriich beansprucht!',
  claimReleased: 'Beanspruchig ufghobe.',
  claimDetailTitle: 'Beanspruchig Details',

  // Filter
  vbOnly: 'Nur VB',
  all: 'Alli',

  // Admin navigation
  updateFutureTrainings: 'Zukünftigi Trainings aktualisiere',
  goToTrainings: 'Zu Trainings',
  goToGames: 'Zu Spiel',

  // Available slots
  slotsAvailable: '{{count}} Halle frei',
  slotsAvailableTitle: 'Freii Halle',
  slotsAvailableNone: 'Käni freie Halle',

  // Wuchetag-Chürzel (Raster- / Übersichtschöpf)
  dayMonShort: 'Mo',
  dayTueShort: 'Di',
  dayWedShort: 'Mi',
  dayThuShort: 'Do',
  dayFriShort: 'Fr',
  daySatShort: 'Sa',
  daySunShort: 'So',

  // Raster- / Editor-Feischliff
  noDataToDisplay: 'Käni Date verfüegbar',
  switchOverlap: 'Überlappig wächsle',
  labelPlaceholder: 'z.B. Schnuppertraining, Heimspiel vs. TVA',
  sportVolleyball: 'Volleyball',
  sportBasketball: 'Basketball',
  claimNotesPlaceholder: 'Optional…',
  closureReasonPlaceholder: 'z.B. Ferie, Unterhalt, Renovation',

  // Hallenverzeichnis (/admin/hallenplan/halls)
  hallsNav: 'Halle',
  hallsTitle: 'Halle verwalte',
  hallsSubtitle: 'D Ort, wo jede Halleslot, jedes Training und jedes Heimspiel druuf zeigt. E Halle mues do existiere, bevor es Team en Slot drin überchunnt.',
  addNewHall: 'Halle hinzuefüege',
  editHall: 'Halle bearbeite',
  hallName: 'Name',
  hallNameHint: 'Bekannte Ort uswähle, damit d Adress übernoh wird, oder eifach en Name iigäh.',
  hallNamePlaceholder: 'z.B. KWI A',
  hallAddress: 'Adress',
  hallCity: 'Ort',
  hallCourts: 'Fälder',
  hallMapsUrl: 'Charte-Link',
  hallHomologation: 'Homologiert',
  hallHomologationHint: 'Für Meisterschaftsspiel zuegloh',
  hallNameRequired: 'Bitte en Hallename iigäh',
  hallSaved: 'Halle gspeicheret',
  hallDeleted: 'Halle glöscht',
  hallDeleteConfirm: '"{{name}}" lösche? Slots, Trainings und Spiel i dere Halle mönd zerscht verschobe werde.',
  hallInUse: 'Die Halle het no Halleslots. Die zerscht entferne.',
  hallsEmpty: 'No kei Halle',
} as const
