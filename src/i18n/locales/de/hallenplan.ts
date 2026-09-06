export default {
  title: 'Hallenplan',
  subtitleDay: 'Tagesansicht der Hallenbelegung',
  subtitleWeek: 'Wochenansicht der Hallenbelegung',

  // Slot form
  hall: 'Halle',
  team: 'Team',
  searchTeam: 'Team suchen…',
  noTeamFound: 'Kein Team gefunden.',
  freeSlot: 'Freier Trainingsslot',
  freeSlotHint: 'Kein Team zugewiesen — für jedes Team zum Beanspruchen freigegeben',
  dayOfWeek: 'Wochentag',
  slotType: 'Typ',
  startTime: 'Startzeit',
  endTime: 'Endzeit',
  recurring: 'Wiederkehrend',
  validFrom: 'Gültig ab',
  validTo: 'Gültig bis',
  indefinitely: 'Unbefristet',
  label: 'Bezeichnung',
  autoLabel: 'Automatische Bezeichnung',
  notes: 'Notizen',

  // Slot types
  typeTraining: 'Training',
  typeGame: 'Spiel',
  typeEvent: 'Event',
  typeOther: 'Andere',

  // Day names (full)
  dayMonday: 'Montag',
  dayTuesday: 'Dienstag',
  dayWednesday: 'Mittwoch',
  dayThursday: 'Donnerstag',
  dayFriday: 'Freitag',
  daySaturday: 'Samstag',
  daySunday: 'Sonntag',

  // Slot editor
  editSlot: 'Slot bearbeiten',
  editSlotTitle: 'Slot bearbeiten',
  newSlotTitle: 'Neuer Slot',
  deleteSlotConfirm: 'Bist du sicher, dass du diesen Slot löschen willst?',
  selectPlaceholder: '-- Auswählen --',

  // Validation
  hallRequired: 'Bitte wähle eine Halle',
  dayRequired: 'Bitte wähle einen Tag',
  startTimeRequired: 'Startzeit ist erforderlich',
  endTimeRequired: 'Endzeit ist erforderlich',

  // Closure manager
  closuresTitle: 'Hallensperrungen verwalten',
  currentClosures: 'Aktuelle Sperrungen',
  addNewClosure: 'Neue Sperrung',
  editClosure: 'Sperrung bearbeiten',
  noClosures: 'Keine aktiven Sperrungen',
  deleteClosureConfirm: 'Bist du sicher, dass du diese Hallensperrung löschen willst?',
  closuresSubtitle: 'Tage, an denen eine Halle geschlossen ist. Eine Sperrung blendet die Halle im Hallenplan aus, erscheint im Kalender und im iCal-Feed, sperrt dort Heimspiele und sagt Trainings an diesen Tagen ab.',
  closuresScopeUpcoming: 'Bevorstehend',
  closuresScopeAll: 'Alle',
  closuresColDates: 'Daten',
  closureAddedToast_one: 'Sperrung hinzugefügt: {{range}}, 1 Halle',
  closureAddedToast_other: 'Sperrung hinzugefügt: {{range}}, {{count}} Hallen',
  closureUpdatedToast_one: 'Sperrung aktualisiert: {{range}}, 1 Halle',
  closureUpdatedToast_other: 'Sperrung aktualisiert: {{range}}, {{count}} Hallen',
  closureDeletedToast: 'Sperrung gelöscht',
  closureSyncOwnedWarning: 'Diese Quelle wird von einem automatischen Sync verwaltet — eine hier gespeicherte Sperrung wird beim nächsten Lauf wieder gelöscht. Nimm «Admin» oder «Hauswart» für eine manuelle Sperrung.',

  // Hall-administration calendar (gcal) — per-entry closure override
  gcalEntriesTitle: 'Kalender der Hallenverwaltung',
  gcalEntriesSubtitle: 'Jeder Eintrag, den die Hallenverwaltung in diesen Kalender stellt, sperrt die KWI-Hallen. Ist ein Eintrag keine echte Sperrung — etwa ein selbst eingetragenes Spiel oder Training des Vereins —, kannst du ihn hier abschalten; abgesagte Trainings werden dann wieder aktiv.',
  gcalEntriesEmpty: 'Keine bevorstehenden Einträge der Hallenverwaltung',
  gcalColEntry: 'Eintrag',
  gcalColEffect: 'Wirkung',
  gcalEffectCloses: 'Sperrt die Hallen',
  gcalEffectOpen: 'Keine Sperrung',
  gcalEffectConfirmed: 'Sperrt die Hallen (bestätigt)',
  gcalActionOpen: 'Keine Sperrung',
  gcalActionClose: 'Hallen sperren',
  gcalCloseConfirm: 'KWI-Hallen für diesen Eintrag sperren? Trainings an diesen Tagen werden abgesagt.',
  gcalOverrideOffToast: 'Keine Sperrung mehr',
  gcalOverrideOnToast: 'Hallen gesperrt',
  gcalTrainingsCancelledToast_one: '1 Training abgesagt',
  gcalTrainingsCancelledToast_other: '{{count}} Trainings abgesagt',
  gcalTrainingsRestoredToast_one: '1 Training ist wieder aktiv',
  gcalTrainingsRestoredToast_other: '{{count}} Trainings sind wieder aktiv',

  // Publishing a club closure to the hall administration's calendar
  gcalPushCol: 'Hallenkalender',
  gcalPushNo: 'Nicht publiziert',
  gcalPushYes: 'Publiziert',
  gcalPushDuplicate: 'Bereits erfasst',
  gcalPushNotEligible: '—',
  gcalPushAction: 'Publizieren',
  gcalPushRemoveAction: 'Entfernen',
  gcalPushConfirm: 'Diese Sperrung im Kalender der Hallenverwaltung publizieren? Sie sehen sie als KSCW-Belegung.',
  gcalPushRemoveConfirm: 'Diese Sperrung aus dem Kalender der Hallenverwaltung entfernen?',
  gcalPushedToast: 'Im Hallenkalender publiziert',
  gcalPushRemovedToast: 'Aus dem Hallenkalender entfernt',
  gcalPushDuplicateToast: 'Nicht publiziert — die Hallenverwaltung hat diesen Zeitraum bereits erfasst ({{title}})',
  gcalPushDryRunToast: 'Zum Publizieren markiert (Dev läuft trocken — nichts geschrieben)',
  gcalPushDisabledToast: 'Markiert, aber der Kalender-Push ist auf dieser Umgebung nicht konfiguriert',



  // Closure sources
  source: 'Quelle',
  sourceCaretaker: 'Hauswart',
  sourceAdmin: 'Admin',
  sourceAutomatic: 'Automatisch',
  sourceGcal: 'Google Kalender',
  sourceSchoolHolidays: 'Schulferien',
  closed: 'Gesperrt',
  allHalls: 'Alle Hallen',
  halls: 'Hallen',
  editAppliesToAllHalls: 'Änderung gilt für {{count}} Hallen',
  hallsField: 'Hallen',
  selectHallsHint: 'Eine oder mehrere Hallen auswählen',
  presetKwi: 'KWI',

  // Navigation
  today: 'Heute',
  closures: 'Sperrungen',
  prevWeek: 'Vorherige Woche',
  nextWeek: 'Nächste Woche',

  // Summary
  summary: 'Übersicht',

  // Virtual slots
  typeAway: 'Auswärts',
  autoGenerated: 'Automatisch generiert',
  cancelled: 'Abgesagt',

  // Virtual slot detail labels
  league: 'Liga',
  start: 'Start',
  slot: 'Slot',
  result: 'Ergebnis',
  location: 'Ort',
  allDay: 'Ganztägig',
  date: 'Datum',
  reason: 'Grund',

  // Game statuses
  statusScheduled: 'Geplant',
  statusLive: 'Live',
  statusCompleted: 'Abgeschlossen',
  statusPostponed: 'Verschoben',

  // Claim system
  slotFreed: 'Frei',
  slotClaimed: 'Beansprucht',
  claimSlotTitle: 'Hallenzeit beanspruchen',
  claimConfirm: 'Beanspruchen',
  claimRelease: 'Freigeben',
  claimReleaseConfirm: 'Bist du sicher, dass du diese Beanspruchung aufheben willst?',
  claimAlreadyTaken: 'Dieser Slot wurde bereits beansprucht.',
  claimPastDate: 'Vergangene Slots können nicht beansprucht werden.',
  claimTeamLabel: 'Für Team',
  claimReasonCancelled: 'Training abgesagt',
  claimReasonAway: 'Auswärtsspiel',
  claimReasonSpielhalle: 'Spielhalle',
  claimOriginalTeam: 'Ursprünglich',
  claimClaimedBy: 'Beansprucht von',
  claimClaimedAt: 'Beansprucht am',
  claimNotes: 'Notizen',
  claimSuccess: 'Slot erfolgreich beansprucht!',
  claimReleased: 'Beanspruchung aufgehoben.',
  claimDetailTitle: 'Beanspruchung Details',

  // Filter
  vbOnly: 'Nur VB',
  all: 'Alle',

  // Admin navigation
  updateFutureTrainings: 'Zukünftige Trainings aktualisieren',
  goToTrainings: 'Zu Trainings',
  goToGames: 'Zu Spiele',

  // Available slots
  slotsAvailable: '{{count}} Halle(n) frei',
  slotsAvailableTitle: 'Freie Hallen',
  slotsAvailableNone: 'Keine freien Hallen',

  // Wochentag-Kürzel (Raster- / Übersichtsköpfe)
  dayMonShort: 'Mo',
  dayTueShort: 'Di',
  dayWedShort: 'Mi',
  dayThuShort: 'Do',
  dayFriShort: 'Fr',
  daySatShort: 'Sa',
  daySunShort: 'So',

  // Raster- / Editor-Feinschliff
  noDataToDisplay: 'Keine Daten vorhanden',
  breakExpand: 'Nichts gebucht {{from}}–{{to}} — klicken, um diese Stunden anzuzeigen',
  switchOverlap: 'Überlappung wechseln',
  labelPlaceholder: 'z.B. Schnuppertraining, Heimspiel vs. TVA',
  sportVolleyball: 'Volleyball',
  sportBasketball: 'Basketball',
  claimNotesPlaceholder: 'Optional…',
  closureReasonPlaceholder: 'z.B. Ferien, Unterhalt, Renovation',

  // Hallenverzeichnis (/admin/hallenplan/halls)
  hallsNav: 'Hallen',
  hallsTitle: 'Hallen verwalten',
  hallsSubtitle: 'Die Orte, auf die jeder Hallenslot, jedes Training und jedes Heimspiel zeigt. Eine Halle muss hier existieren, bevor ein Team einen Slot darin bekommen kann.',
  addNewHall: 'Halle hinzufügen',
  editHall: 'Halle bearbeiten',
  hallName: 'Name',
  hallNameHint: 'Bekannten Ort auswählen, um die Adresse zu übernehmen, oder einfach einen Namen eingeben.',
  hallNamePlaceholder: 'z.B. KWI A',
  hallAddress: 'Adresse',
  hallCity: 'Ort',
  hallCourts: 'Felder',
  hallMapsUrl: 'Karten-Link',
  hallHomologation: 'Homologiert',
  hallHomologationHint: 'Für Meisterschaftsspiele zugelassen',
  hallNameRequired: 'Bitte einen Hallennamen eingeben',
  hallSaved: 'Halle gespeichert',
  hallDeleted: 'Halle gelöscht',
  hallDeleteConfirm: '"{{name}}" löschen? Das kann nicht rückgängig gemacht werden.',
  hallsEmpty: 'Noch keine Hallen',
  hallImpactRemoved: 'Wird mitgelöscht:',
  hallImpactKept: 'Bleibt bestehen, aber ohne Halle:',
  hallImpactSlots: '{{count}} Hallenslot(s)',
  hallImpactClosures: '{{count}} Schliessung(en)',
  hallImpactTrainings: '{{count}} Training(s)',
  hallImpactGames: '{{count}} Spiel(e)',
  hallImpactUnknown: 'Konnte nicht prüfen, was von dieser Halle abhängt.',
} as const
