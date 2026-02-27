export default {
  title: 'Absences',
  subtitle: 'Centralized absence management',

  // Tabs
  tabMyAbsences: 'My Absences',
  tabTeamAbsences: 'Team Absences',

  // Actions
  newAbsence: 'New Absence',

  // Form
  member: 'Member',
  startDate: 'From',
  endDate: 'To',
  reason: 'Reason',
  detailsOptional: 'Details (optional)',
  detailsPlaceholder: 'Additional information...',
  affects: 'Affects',

  // Reason options
  reasonInjury: 'Injury',
  reasonVacation: 'Vacation',
  reasonWork: 'Work',
  reasonPersonal: 'Personal',
  reasonOther: 'Other',

  // Affects options
  affectsTrainings: 'Trainings',
  affectsGames: 'Games',
  affectsAll: 'All',

  // Status
  approved: 'Approved',

  // Validation
  startDateRequired: 'Start date is required',
  endDateRequired: 'End date is required',
  endAfterStart: 'End date must be after start date',
  reasonRequired: 'Please select a reason',
  memberRequired: 'Please select a member',
  errorSaving: 'Error saving absence',

  // Modal titles
  newAbsenceTitle: 'New Absence',
  editAbsenceTitle: 'Edit Absence',

  // Delete dialog
  deleteTitle: 'Delete Absence',
  deleteMessage: 'Are you sure you want to delete this absence?',

  // Empty states
  noAbsences: 'No absences',
  noAbsencesDescription: 'No absences found.',
  noTeamAbsences: 'No absences',
  noTeamAbsencesDescription: 'No reported absences in this period.',

  // Team absence view
  fromTo: 'From',
  until: 'To',
} as const
