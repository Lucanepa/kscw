export default {
  title: 'Calendar',

  // View options
  viewHall: 'Hall',
  viewWeek: 'Week',
  viewMonth: 'Month',
  viewList: 'List',

  // Subtitles
  subtitleHall: 'Hall occupancy plan',
  subtitleWeek: 'Weekly overview of all events',
  subtitleMonth: 'Monthly overview of all events',
  subtitleList: 'All events in chronological order',

  // Source filters
  sourceGames: 'Games',
  sourceTrainings: 'Trainings',
  sourceClosures: 'Closures',
  sourceEvents: 'Events',

  // Game type filters
  gameTypeHome: 'Home',
  gameTypeAway: 'Away',
  sourceHallHW: 'Halle HW',

  // Type labels
  typeGame: 'Game',
  typeTraining: 'Training',
  typeClosure: 'Hall closure',
  typeEvent: 'Event',
  typeHall: 'Hall booking',

  // Other
  noEntries: 'No entries found',
  weekLabel: 'CW {{week}}: {{start}} – {{end}}',
  exportICal: 'Export iCal',
  subscribeICal: 'Subscribe',

  // iCal modal
  icalSubscribeTitle: 'Subscribe to calendar',
  icalDownloadTitle: 'Export calendar',
  icalFilterLabel: 'What do you want?',
  icalPresetAll: 'Everything',
  icalPresetGames: 'Games only',
  icalPresetHomeGames: 'Home games only',
  icalPresetTrainings: 'Trainings only',
  icalTeamFilter: 'Filter by team',
  icalTeamHint: 'Empty = all teams',
} as const
