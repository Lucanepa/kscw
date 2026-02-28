export default {
  title: 'Absenzen',
  subtitle: 'Zentrale Absenzenverwaltung',

  // Tabs
  tabMyAbsences: 'Meine Absenzen',
  tabTeamAbsences: 'Team Absenzen',

  // Actions
  newAbsence: 'Neue Absenz',

  // Form
  member: 'Mitglied',
  startDate: 'Von',
  endDate: 'Bis',
  reason: 'Grund',
  detailsOptional: 'Details (optional)',
  detailsPlaceholder: 'Zusätzliche Informationen...',
  affects: 'Betrifft',

  // Reason options
  reasonInjury: 'Verletzung',
  reasonVacation: 'Ferien',
  reasonWork: 'Arbeit',
  reasonPersonal: 'Persönlich',
  reasonOther: 'Sonstiges',

  // Affects options
  affectsTrainings: 'Trainings',
  affectsGames: 'Spiele',
  affectsAll: 'Alles',

  // Status
  approved: 'Genehmigt',

  // Validation
  startDateRequired: 'Startdatum ist erforderlich',
  endDateRequired: 'Enddatum ist erforderlich',
  endAfterStart: 'Enddatum muss nach dem Startdatum sein',
  reasonRequired: 'Bitte wähle einen Grund',
  memberRequired: 'Bitte wähle ein Mitglied',
  errorSaving: 'Fehler beim Speichern der Absenz',

  // Modal titles
  newAbsenceTitle: 'Neue Absenz',
  editAbsenceTitle: 'Absenz bearbeiten',

  // Delete dialog
  deleteTitle: 'Absenz löschen',
  deleteMessage: 'Bist du sicher, dass du diese Absenz löschen willst?',

  // Empty states
  noAbsences: 'Keine Absenzen',
  noAbsencesDescription: 'Keine Absenzen gefunden.',
  noTeamAbsences: 'Keine Absenzen',
  noTeamAbsencesDescription: 'Keine gemeldeten Absenzen in diesem Zeitraum.',

  // Team absence view
  fromTo: 'Von',
  until: 'Bis',
} as const
