export default {
  title: 'Hall plan',
  subtitleDay: 'Daily view of hall occupancy',
  subtitleWeek: 'Weekly view of hall occupancy',

  // Slot form
  hall: 'Hall',
  team: 'Team',
  searchTeam: 'Search team…',
  noTeamFound: 'No team found.',
  freeSlot: 'Free training slot',
  freeSlotHint: 'No team assigned — released for any team to claim',
  dayOfWeek: 'Day of week',
  slotType: 'Type',
  startTime: 'Start time',
  endTime: 'End time',
  recurring: 'Recurring',
  validFrom: 'Valid from',
  validTo: 'Valid to',
  indefinitely: 'Indefinitely',
  label: 'Label',
  autoLabel: 'Auto label',
  notes: 'Notes',

  // Slot types
  typeTraining: 'Training',
  typeGame: 'Game',
  typeEvent: 'Event',
  typeOther: 'Other',

  // Day names (full)
  dayMonday: 'Monday',
  dayTuesday: 'Tuesday',
  dayWednesday: 'Wednesday',
  dayThursday: 'Thursday',
  dayFriday: 'Friday',
  daySaturday: 'Saturday',
  daySunday: 'Sunday',

  // Slot editor
  editSlot: 'Edit slot',
  editSlotTitle: 'Edit slot',
  newSlotTitle: 'New slot',
  deleteSlotConfirm: 'Are you sure you want to delete this slot?',
  selectPlaceholder: '-- Select --',

  // Validation
  hallRequired: 'Please select a hall',
  dayRequired: 'Please select a day',
  startTimeRequired: 'Start time is required',
  endTimeRequired: 'End time is required',

  // Closure manager
  closuresTitle: 'Manage hall closures',
  currentClosures: 'Current closures',
  addNewClosure: 'Add new closure',
  editClosure: 'Edit closure',
  noClosures: 'No active closures',
  deleteClosureConfirm: 'Are you sure you want to delete this hall closure?',
  closuresSubtitle: 'Days a hall is shut. A closure hides the hall in the Hallenplan, shows up in the calendar and the iCal feed, blocks home games there and cancels trainings on those days.',
  closuresScopeUpcoming: 'Upcoming',
  closuresScopeAll: 'All',
  closuresColDates: 'Dates',
  closureAddedToast_one: 'Closure added: {{range}}, 1 hall',
  closureAddedToast_other: 'Closure added: {{range}}, {{count}} halls',
  closureUpdatedToast_one: 'Closure updated: {{range}}, 1 hall',
  closureUpdatedToast_other: 'Closure updated: {{range}}, {{count}} halls',
  closureDeletedToast: 'Closure deleted',
  closureSyncOwnedWarning: 'This source is managed by an automatic sync — a closure saved here is deleted again on the next run. Use "Admin" or "Caretaker" for a manual closure.',

  // Hall-administration calendar (gcal) — per-entry closure override
  gcalEntriesTitle: 'Hall administration calendar',
  gcalEntriesSubtitle: 'Every entry the hall administration puts on this calendar closes the KWI halls. If one of them is not really a closure — a club game or training they typed in themselves — switch it off here and any training it cancelled comes back.',
  gcalEntriesEmpty: 'No upcoming entries from the hall administration',
  gcalColEntry: 'Entry',
  gcalColEffect: 'Effect',
  gcalEffectCloses: 'Closes the halls',
  gcalEffectOpen: 'No closure',
  gcalEffectConfirmed: 'Closes the halls (confirmed)',
  gcalActionOpen: 'Not a closure',
  gcalActionClose: 'Close the halls',
  gcalCloseConfirm: 'Close the KWI halls for this entry? Trainings on those days will be cancelled.',
  gcalOverrideOffToast: 'No longer a closure',
  gcalOverrideOnToast: 'Halls closed',
  gcalTrainingsCancelledToast_one: '1 training cancelled',
  gcalTrainingsCancelledToast_other: '{{count}} trainings cancelled',
  gcalTrainingsRestoredToast_one: '1 training is active again',
  gcalTrainingsRestoredToast_other: '{{count}} trainings are active again',

  // Publishing a club closure to the hall administration's calendar
  gcalPushCol: 'Hall calendar',
  gcalPushNo: 'Not published',
  gcalPushYes: 'Published',
  gcalPushDuplicate: 'They have it',
  gcalPushNotEligible: '—',
  gcalPushAction: 'Publish',
  gcalPushRemoveAction: 'Remove',
  gcalPushConfirm: 'Publish this closure to the hall administration\'s calendar? They will see it as a KSCW booking.',
  gcalPushRemoveConfirm: 'Remove this closure from the hall administration\'s calendar?',
  gcalPushedToast: 'Published to the hall calendar',
  gcalPushRemovedToast: 'Removed from the hall calendar',
  gcalPushDuplicateToast: 'Not published — the hall administration already has this covered ({{title}})',
  gcalPushDryRunToast: 'Marked for publishing (dev runs dry — nothing was written)',
  gcalPushDisabledToast: 'Marked, but calendar push is not configured on this environment',



  // Closure sources
  source: 'Source',
  sourceCaretaker: 'Caretaker',
  sourceAdmin: 'Admin',
  sourceAutomatic: 'Automatic',
  sourceGcal: 'Google Calendar',
  sourceSchoolHolidays: 'School holidays',
  closed: 'Closed',
  allHalls: 'All halls',
  halls: 'halls',
  editAppliesToAllHalls: 'Change applies to {{count}} halls',
  hallsField: 'Halls',
  selectHallsHint: 'Select one or more halls',
  presetKwi: 'KWI',

  // Navigation
  today: 'Today',
  closures: 'Closures',
  prevWeek: 'Previous week',
  nextWeek: 'Next week',

  // Summary
  summary: 'Summary',

  // Virtual slots
  typeAway: 'Away',
  autoGenerated: 'Auto-generated',
  cancelled: 'Cancelled',

  // Virtual slot detail labels
  league: 'League',
  start: 'Start',
  slot: 'Slot',
  result: 'Result',
  location: 'Location',
  allDay: 'All day',
  date: 'Date',
  reason: 'Reason',

  // Game statuses
  statusScheduled: 'Scheduled',
  statusLive: 'Live',
  statusCompleted: 'Completed',
  statusPostponed: 'Postponed',

  // Claim system
  slotFreed: 'Available',
  slotClaimed: 'Claimed',
  claimSlotTitle: 'Claim hall time',
  claimConfirm: 'Claim',
  claimRelease: 'Release',
  claimReleaseConfirm: 'Are you sure you want to release this claim?',
  claimAlreadyTaken: 'This slot has already been claimed.',
  claimPastDate: 'Past slots cannot be claimed.',
  claimTeamLabel: 'For team',
  claimReasonCancelled: 'Training cancelled',
  claimReasonAway: 'Away game',
  claimReasonSpielhalle: 'Spielhalle',
  claimOriginalTeam: 'Originally',
  claimClaimedBy: 'Claimed by',
  claimClaimedAt: 'Claimed on',
  claimNotes: 'Notes',
  claimSuccess: 'Slot claimed successfully!',
  claimReleased: 'Claim released.',
  claimDetailTitle: 'Claim details',

  // Filter
  vbOnly: 'VB only',
  all: 'All',

  // Admin navigation
  updateFutureTrainings: 'Update future trainings',
  goToTrainings: 'Go to trainings',
  goToGames: 'Go to games',

  // Available slots
  slotsAvailable: '{{count}} slot(s) available',
  slotsAvailableTitle: 'Available slots',
  slotsAvailableNone: 'No available slots',

  // Weekday abbreviations (grid / summary headers) — German-style in DE/GSW
  dayMonShort: 'Mon',
  dayTueShort: 'Tue',
  dayWedShort: 'Wed',
  dayThuShort: 'Thu',
  dayFriShort: 'Fri',
  daySatShort: 'Sat',
  daySunShort: 'Sun',

  // Grid / editor polish
  noDataToDisplay: 'No data to display',
  switchOverlap: 'Switch overlap',
  labelPlaceholder: 'e.g. Trial training, Home game vs. TVA',
  sportVolleyball: 'Volleyball',
  sportBasketball: 'Basketball',
  claimNotesPlaceholder: 'Optional…',
  closureReasonPlaceholder: 'e.g. Holidays, maintenance, renovation',

  // Halls register (/admin/hallenplan/halls)
  hallsNav: 'Halls',
  hallsTitle: 'Manage halls',
  hallsSubtitle: 'The venues every hall slot, training and home game points at. A hall has to exist here before a team can be given a slot in it.',
  addNewHall: 'Add hall',
  editHall: 'Edit hall',
  hallName: 'Name',
  hallNameHint: 'Pick a known venue to fill in the address, or just type a name.',
  hallNamePlaceholder: 'e.g. KWI A',
  hallAddress: 'Address',
  hallCity: 'City',
  hallCourts: 'Courts',
  hallMapsUrl: 'Maps link',
  hallHomologation: 'Homologated',
  hallHomologationHint: 'Approved for league games',
  hallNameRequired: 'Please enter a hall name',
  hallSaved: 'Hall saved',
  hallDeleted: 'Hall deleted',
  hallDeleteConfirm: 'Delete "{{name}}"? Slots, trainings and games in this hall have to be moved first.',
  hallInUse: 'This hall still has hall slots. Remove them first.',
  hallsEmpty: 'No halls yet',
} as const
