export default {
  title: 'Hallenplan',
  subtitleDay: 'Tagesansicht der Hallenbelegung',
  subtitleWeek: 'Wochenansicht der Hallenbelegung',

  // Slot form
  hall: 'Halle',
  team: 'Team',
  dayOfWeek: 'Wochentag',
  slotType: 'Typ',
  startTime: 'Startzeit',
  endTime: 'Endzeit',
  recurring: 'Wiederkehrend',
  validFrom: 'Gültig ab',
  validTo: 'Gültig bis',
  label: 'Bezeichnung',
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

  // Closure sources
  source: 'Quelle',
  sourceCaretaker: 'Hauswart',
  sourceAdmin: 'Admin',
  sourceAutomatic: 'Automatisch',

  // Navigation
  today: 'Heute',
  closures: 'Sperrungen',
  prevWeek: 'Vorherige Woche',
  nextWeek: 'Nächste Woche',
} as const
