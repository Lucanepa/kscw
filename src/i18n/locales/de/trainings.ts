export default {
  /** Migration 354: trainings_hall_slot_date_uq rejected a concurrent create. */
  duplicateSlotDate: 'Für diesen Hallenslot existiert an diesem Datum bereits ein Training. Aktualisiere und versuche es erneut — jemand hat es vielleicht gerade erstellt.',
  title: 'Trainings',
  subtitle: 'Trainingsübersicht mit Anwesenheitskontrolle',

  // Tabs
  tabTrainings: 'Trainings',
  tabCoachDashboard: 'Trainer Dashboard',

  // Training card
  attendance: 'Anwesenheit',
  cancelled: 'Abgesagt',

  // Attendance sheet
  attendanceTitle: 'Anwesenheit — {{date}}',
  attendanceTitleShort: 'Anwesenheit',
  noPlayers: 'Keine Spieler',
  noPlayersAssigned: 'Diesem Team wurden noch keine Spieler zugewiesen.',

  // Coach dashboard
  seasonLabel: 'Saison',
  rangeFromLabel: 'Von',
  rangeToLabel: 'Bis',
  resetRange: 'Auf Standard zurücksetzen',
  rangeInvalid: '"Von" muss vor oder gleich "Bis" sein',
  noDataAvailable: 'Keine Daten verfügbar',
  noDataDescription: 'Keine Anwesenheitsdaten vorhanden.',

  // Table headers
  playerCol: 'Spieler',
  numberCol: '#',
  trainingsCol: 'Trainings',
  presentCol: 'Anwesend',
  absentCol: 'Abwesend',
  rateCol: 'Quote',
  trendCol: 'Trend',

  // Filter
  showPast: 'Ältere Trainings anzeigen',
  hidePast: 'Ältere Trainings ausblenden',

  // Empty states
  noTrainings: 'Keine Trainings',
  noTrainingsDescription: 'Keine Trainings für die ausgewählten Filter gefunden.',

  // CRUD
  newTraining: 'Neues Training',
  newSingleTraining: 'Einzelnes Training',
  newRecurringTraining: 'Wiederkehrende Trainings',
  editTraining: 'Training bearbeiten',
  deleteTraining: 'Training löschen',
  deleteConfirm: 'Bist du sicher, dass du dieses Training löschen willst?',
  cancelTraining: 'Training absagen',
  trainingCancelled: 'Training abgesagt',
  cancelReason: 'Grund der Absage',

  // Recurring
  recurringTitle: 'Wiederkehrende Trainings erstellen',
  selectSlot: 'Hallenslot wählen',
  dateRange: 'Zeitraum',
  generatePreview: 'Vorschau Daten',
  generate: 'Erstellen',
  trainingsGenerated: '{{count}} Trainings erstellt',
  trainingsSkipped: '{{count}} übersprungen (bereits vorhanden)',
  respondBy: 'Antwort bis',
  respondByHint: 'Erinnerung 1 Tag vorher',
  respondByTime: 'Anmeldefrist Uhrzeit',
  respondByHours: 'Stunden',
  respondByDays: 'Tage',
  respondByWeeks: 'Wochen',
  respondByMonths: 'Monate',
  respondByBefore: 'vorher',
  participation: 'Teilnahme',
  minParticipants: 'Min. Teilnehmer',
  maxParticipants: 'Max. Teilnehmer',
  untilSeasonEnd: 'Unbefristet',
  slotFrom: 'ab',
  slotUntil: 'bis',

  // Recurring edit
  editRecurringTitle: 'Wiederkehrendes Training bearbeiten',
  editRecurringDescription: 'Dieses Training gehört zu einer wiederkehrenden Serie. Was möchtest du bearbeiten?',
  editThisOnly: 'Nur dieses Training',
  editSameDay: 'Alle Trainings am gleichen Wochentag',
  editAllRecurring: 'Alle wiederkehrenden Trainings',
  cancelEdit: 'Abbrechen',

  // Slot mode
  slotDetected: 'Hallenslot erkannt',
  claimedSlot: 'Beanspruchter Slot',
  regularSlot: 'Regulärer Slot',
  noSlotForDay: 'Kein Hallenslot an diesem Tag',
  useSlot: 'Hallenslot verwenden',
  enterManually: 'Manuell eingeben',
  slotModeAuto: 'Auto Hallenslot',
  slotModeManual: 'Manuell',
  autoCancelOnMin: 'Automatisch absagen',
  autoCancelOnMinHint: 'Training wird bei Fristablauf automatisch abgesagt, wenn weniger Zusagen als das Minimum vorliegen',
  excludedGuestLevels: 'Ausgeschlossene Gäste',
  excludedGuestLevelsHint: 'Gäste der ausgewählten Stufen können nicht zusagen oder als unsicher markieren',
  excludeAllGuests: 'Alle Gäste',
  guestExcluded: 'Deine Gaststufe ist von diesem Training ausgeschlossen',
  autoConfirmRsvp: 'Automatisch bestätigen',
  autoConfirmRsvpHint: 'Team-Standard überschreiben ({{default}}). Alle berechtigten Mitglieder starten als bestätigt; sie müssen sich aktiv abmelden.',
  useTeamDefault: 'Team-Standard',
  on: 'An',
  off: 'Aus',
  isTrialTraining: 'Probetraining',
  isTrialTrainingHint: 'Auf der Teamseite öffentlich sichtbar, wenn das Team für neue Spieler offen ist.',
  trialBadge: 'Probetraining',
  shortenedBadge: 'Verkürzt',
  shortenedHint: 'Endet früher — anschliessend Heimspiel in der Halle',

  // Serie — manuell (ohne Hallenslot)
  weekday: 'Wochentag',
  manualStartTime: 'Startzeit',
  manualEndTime: 'Endzeit',
  manualHint: 'Es wird kein Hallenslot verwendet. Wochentag, Zeiten und Halle selbst wählen — die Serie hängt an keinem Slot, eine Absage gibt also keine Hallenzeit für andere Teams frei.',
  manualEndAfterStart: 'Die Endzeit muss nach der Startzeit liegen.',
  noSlotsForTeam: 'Dieses Team hat keine Hallenslots. Auf manuelle Eingabe wechseln, um trotzdem eine Serie zu erzeugen.',
} as const
