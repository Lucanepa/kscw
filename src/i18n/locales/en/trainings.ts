export default {
  title: 'Trainings',
  subtitle: 'Training overview with attendance tracking',

  // Tabs
  tabTrainings: 'Trainings',
  tabCoachDashboard: 'Coach Dashboard',

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

  // Empty states
  noTrainings: 'No trainings',
  noTrainingsDescription: 'No trainings found for the selected filters.',

  // CRUD
  newTraining: 'New Training',
  editTraining: 'Edit Training',
  deleteTraining: 'Delete Training',
  deleteConfirm: 'Are you sure you want to delete this training?',
  cancelTraining: 'Cancel training',
  cancelReason: 'Cancellation reason',

  // Recurring
  recurringTitle: 'Generate Recurring Trainings',
  selectSlot: 'Select hall slot',
  dateRange: 'Date range',
  generatePreview: 'Preview dates',
  generate: 'Generate',
  trainingsGenerated: '{{count}} trainings generated',
} as const
