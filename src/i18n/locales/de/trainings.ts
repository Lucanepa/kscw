export default {
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

  // Empty states
  noTrainings: 'Keine Trainings',
  noTrainingsDescription: 'Keine Trainings für die ausgewählten Filter gefunden.',

  // CRUD
  newTraining: 'Neues Training',
  editTraining: 'Training bearbeiten',
  deleteTraining: 'Training löschen',
  deleteConfirm: 'Bist du sicher, dass du dieses Training löschen willst?',
  cancelTraining: 'Training absagen',
  cancelReason: 'Grund der Absage',

  // Recurring
  recurringTitle: 'Wiederkehrende Trainings erstellen',
  selectSlot: 'Hallenslot wählen',
  dateRange: 'Zeitraum',
  generatePreview: 'Vorschau Daten',
  generate: 'Erstellen',
  trainingsGenerated: '{{count}} Trainings erstellt',
} as const
