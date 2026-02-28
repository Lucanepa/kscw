export default {
  title: 'Kalender',

  // View options
  viewHall: 'Halle',
  viewMonth: 'Monat',
  viewList: 'Liste',

  // Subtitles
  subtitleHall: 'Hallenbelegungsplan',
  subtitleMonth: 'Monatsübersicht aller Termine',
  subtitleList: 'Alle Termine chronologisch',

  // Source filters
  sourceGames: 'Spiele',
  sourceTrainings: 'Trainings',
  sourceClosures: 'Sperrungen',
  sourceEvents: 'Events',

  // Game type filters
  gameTypeHome: 'Heim',
  gameTypeAway: 'Auswärts',
  sourceHallHW: 'Halle HW',

  // Type labels
  typeGame: 'Spiel',
  typeTraining: 'Training',
  typeClosure: 'Hallensperrung',
  typeEvent: 'Event',
  typeHall: 'Hallenbelegung',

  // Other
  noEntries: 'Keine Einträge gefunden',
  weekLabel: 'KW {{week}}: {{start}} – {{end}}',
  exportICal: 'iCal exportieren',
  subscribeICal: 'Abonnieren',

  // iCal modal
  icalSubscribeTitle: 'Kalender abonnieren',
  icalDownloadTitle: 'Kalender exportieren',
  icalFilterLabel: 'Was möchtest du?',
  icalPresetAll: 'Alles',
  icalPresetGames: 'Nur Spiele',
  icalPresetHomeGames: 'Nur Heimspiele',
  icalPresetTrainings: 'Nur Trainings',
  icalTeamFilter: 'Nach Team filtern',
  icalTeamHint: 'Leer = alle Teams',
} as const
