export default {
  title: 'Scorer duty',
  subtitle: 'Manage scorer and referee assignments for home games.',

  // Tabs
  tabGames: 'Games',
  tabOverview: 'Overview',

  // Labels
  scorer: 'Scorer',
  referee: 'Referee',
  scorerTaefeler: 'Scorer/Referee',
  confirmed: 'Confirmed',

  // Status labels
  statusConfirmed: 'Confirmed',
  statusAssigned: 'Assigned',
  statusOpen: 'Open',

  // Filters
  filterDate: 'Date',
  filterDutyTeam: 'Duty Team',
  filterDutyType: 'Duty Type',
  filterUnassigned: 'Unassigned Duty',
  filterSearchAssignee: 'Look for assignee',
  filterAllTeams: 'All Teams',
  filterAllTypes: 'All Types',
  filterAllDuties: 'All Duties',
  filterAnyUnassigned: 'Any unassigned',
  searchAssigneePlaceholder: 'Search assignees...',
  clearFilters: 'Clear Filters',

  // Empty state
  noGames: 'No games',
  noGamesDescription: 'No games found for the selected filter.',

  // Past games
  showOlderGames: 'Show older games ({{count}})',
  loadMore: 'Load more',
  hidePast: 'Hide older games',

  // Actions
  exportICal: 'Add to calendar',
  unassigned: 'Unassigned',
  unconfirm: 'Undo confirmation',

  // Self-assign
  selfAssign: 'Sign me up',
  confirmSelfAssignTitle: 'Confirm assignment',
  confirmSelfAssignMessage: 'Do you want to sign up as {{role}} for {{game}} on {{date}}?',
  cancelAction: 'Cancel',
  confirmAction: 'Confirm',

  // Placeholders
  selectTeam: '— Select team —',
  selectPerson: '— Select person —',

  // Overview
  overviewEmpty: 'No assignments found.',
  dutyCount: '{{count}} duties',

  // Permissions
  permissionsNotice: 'Scorer assignments can only be managed by admins and coaches.',
} as const
