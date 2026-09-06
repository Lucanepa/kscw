export default {
  title: 'Trainings',
  subtitle: 'Training overview with attendance tracking',

  // Tabs
  tabTrainings: 'Trainings',
  tabCoachDashboard: 'Coach dashboard',

  // Training card
  attendance: 'Attendance',
  cancelled: 'Cancelled',

  // Attendance sheet
  attendanceTitle: 'Attendance — {{date}}',
  attendanceTitleShort: 'Attendance',
  noPlayers: 'No players',
  noPlayersAssigned: 'No players have been assigned to this team yet.',

  // Coach dashboard
  seasonLabel: 'Season',
  rangeFromLabel: 'From',
  rangeToLabel: 'To',
  resetRange: 'Reset to defaults',
  rangeInvalid: '"From" must be on or before "To"',
  noDataAvailable: 'No data available',
  noDataDescription: 'No attendance data to display.',

  // Table headers
  playerCol: 'Player',
  numberCol: '#',
  trainingsCol: 'Trainings',
  presentCol: 'Present',
  absentCol: 'Absent',
  rateCol: 'Rate',
  trendCol: 'Trend',

  // Filter
  showPast: 'Show older trainings',
  hidePast: 'Hide older trainings',

  // Empty states
  noTrainings: 'No trainings',
  noTrainingsDescription: 'No trainings found for the selected filters.',

  // CRUD
  newTraining: 'New training',
  newSingleTraining: 'Single training',
  newRecurringTraining: 'Recurring trainings',
  editTraining: 'Edit training',
  deleteTraining: 'Delete training',
  deleteConfirm: 'Are you sure you want to delete this training?',
  cancelTraining: 'Cancel training',
  trainingCancelled: 'Training cancelled',
  cancelReason: 'Cancellation reason',

  // Recurring
  recurringTitle: 'Generate recurring trainings',
  selectSlot: 'Select hall slot',
  dateRange: 'Date range',
  generatePreview: 'Preview dates',
  generate: 'Generate',
  trainingsGenerated: '{{count}} trainings generated',
  trainingsSkipped: '{{count}} skipped (already existed)',
  respondBy: 'Respond by',
  respondByHint: 'Reminder 1 day before',
  respondByTime: 'Deadline time',
  respondByHours: 'hours',
  respondByDays: 'days',
  respondByWeeks: 'weeks',
  respondByMonths: 'months',
  respondByBefore: 'before',
  participation: 'Participation',
  minParticipants: 'Min. participants',
  maxParticipants: 'Max. participants',
  untilSeasonEnd: 'Indefinitely',
  slotFrom: 'from',
  slotUntil: 'until',

  // Recurring edit
  editRecurringTitle: 'Edit recurring training',
  editRecurringDescription: 'This training is part of a recurring series. What do you want to edit?',
  editThisOnly: 'This training only',
  editSameDay: 'All trainings on the same weekday',
  editAllRecurring: 'All recurring trainings',
  cancelEdit: 'Cancel',

  // Slot mode
  slotDetected: 'Hall slot detected',
  claimedSlot: 'Claimed slot',
  regularSlot: 'Regular slot',
  noSlotForDay: 'No hall slot for this day',
  useSlot: 'Use hall slot',
  enterManually: 'Enter manually',
  slotModeAuto: 'Auto hall slot',
  slotModeManual: 'Manual',
  autoCancelOnMin: 'Auto-cancel',
  autoCancelOnMinHint: 'Training will be automatically cancelled at the deadline if fewer confirmations than the minimum',
  excludedGuestLevels: 'Excluded guests',
  excludedGuestLevelsHint: 'Guests at the selected tiers cannot confirm or mark themselves as tentative',
  excludeAllGuests: 'All guests',
  guestExcluded: 'Your guest tier is excluded from this training',
  autoConfirmRsvp: 'Auto-confirm RSVP',
  autoConfirmRsvpHint: 'Override team default ({{default}}). All eligible members start as confirmed; they must opt out.',
  useTeamDefault: 'Use team default',
  on: 'On',
  off: 'Off',
  isTrialTraining: 'Trial training (Probetraining)',
  isTrialTrainingHint: 'Publicly visible on the team page when the team is open for new players.',
  trialBadge: 'Probetraining',
  shortenedBadge: 'Shortened',
  shortenedHint: 'Ends earlier — home game in this hall afterwards',

  // Recurring — manual (no hall slot)
  weekday: 'Weekday',
  manualStartTime: 'Start time',
  manualEndTime: 'End time',
  manualHint: 'No hall slot is used. Pick the weekday, times and hall yourself — the series is not tied to a slot, so cancelling a training does not free hall time for other teams.',
  manualEndAfterStart: 'The end time has to be after the start time.',
  noSlotsForTeam: 'This team has no hall slots. Switch to manual entry to generate a series anyway.',
} as const
