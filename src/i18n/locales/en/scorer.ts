export default {
  title: 'Scorer duty',
  subtitle: 'Manage scorer and scoreboard assignments for home games.',

  // Tabs
  tabGames: 'Games',
  tabOverview: 'Overview',
  dutyScopeAll: 'All',
  dutyScopeMine: 'Selected',

  // Labels — Volleyball
  scorer: 'Scorer',
  scoreboard: 'Scoreboard',
  scorerTaefeler: 'Scorer/Scoreboard',
  referee: 'Referee',
  confirmed: 'Confirmed',

  // Labels — Basketball
  bbScorer: 'Scorer (OTR1)',
  bbTimekeeper: 'Timekeeper (OTR1)',
  bb24sOfficial: '24" official (OTR2)',
  bbDutyTeam: 'Officials team',

  // Sport toggle
  sportVolleyball: 'Volleyball',
  sportBasketball: 'Basketball',
  officialsDuties: 'Officials',
  dutyTeam: 'Duty team',

  // Status labels
  statusConfirmed: 'Confirmed',
  statusAssigned: 'Assigned',
  statusOpen: 'Open',
  confirmedBy: 'Confirmed by',

  // Filters
  filters: 'Filters',
  filterDate: 'Date',
  filterDutyTeam: 'Duty team',
  filterPlayingTeam: 'Playing team',
  overviewByTeam: 'By duty team',
  overviewByGame: 'By game',
  overviewColTeam: 'Team',
  overviewColDuties: 'Duties',
  overviewColOpen: 'Open',
  filterDutyType: 'Duty type',
  filterUnassigned: 'Unassigned duty',
  filterSearchAssignee: 'Look for assignee',
  filterAllTeams: 'All teams',
  filterAllTypes: 'All types',
  filterAllDuties: 'All duties',
  filterAnyUnassigned: 'Any unassigned',
  searchAssigneePlaceholder: 'Search assignees...',
  clearFilters: 'Clear filters',

  // Empty state
  noGames: 'No games',
  noGamesDescription: 'No games found for the selected filter.',
  noPastGamesThisSeason: 'No past games this season',

  // Error toasts
  errorUpdate: 'Could not update the assignment.',
  errorToggleReminders: 'Could not change the reminder setting.',
  errorDelegate: 'Could not send the delegation.',
  errorAcceptDelegation: 'Could not accept the request.',
  errorDeclineDelegation: 'Could not decline the request.',

  // Past games
  showOlderGames: 'Show older games',
  loadMore: 'Load more',
  hidePast: 'Hide older games',

  // Actions
  exportICal: 'Add to calendar',
  unassigned: 'Unassigned',
  unconfirm: 'Undo confirmation',
  hide: 'Hide',

  // Self-assign
  selfAssign: 'Sign me up',
  selfAssignSuccess: 'Signed up — see you there!',
  selfAssignError: 'Could not sign up — it may have just been taken, or you are not eligible.',
  confirmSelfAssignTitle: 'Confirm assignment',
  confirmSelfAssignMessage: 'You are signing up as <strong>{{role}}</strong> for <strong>{{game}}</strong> on <strong>{{date}}</strong>.',
  confirmSelfAssignArrival_scorer: 'You must be in the hall at least <strong>30 minutes</strong> before the start of play.',
  confirmSelfAssignArrival_scoreboard: 'You must be in the hall at least <strong>15 minutes</strong> before the start of play.',
  confirmSelfAssignArrival_scorer_scoreboard: 'You must be in the hall at least <strong>30 minutes</strong> before the start of play.',
  confirmSelfAssignArrival_referee: 'You must be in the hall at least <strong>30 minutes</strong> before the start of play.',
  confirmSelfAssignArrival_bb: 'You must be in the hall at least <strong>15 minutes</strong> before the start of play.',
  confirmSelfAssignWarning: 'This choice is <strong>final</strong>. Once you take a duty you cannot drop it — the only way to give it up is to <strong>delegate it to another member</strong>.',
  confirmSelfAssignAbsence: 'You have an absence marked on this date. You can still take the duty, but check your availability first.',
  cancelAction: 'Cancel',
  confirmAction: 'Confirm',

  // Placeholders
  selectTeam: 'Select team',
  selectPerson: 'Select person',
  pickDutyTeamTitle: 'Which duty team?',
  pickDutyTeamBody: '{{name}} is in more than one team — pick the one covering this duty.',

  // Overview
  overviewEmpty: 'No assignments found.',
  dutyCount: '{{count}} duties',

  // Permissions
  permissionsNotice: 'Scorer assignments can only be managed by admins and coaches.',

  // iCal export
  scorerDutyIcal: 'Scorer duty: {{home}} vs {{away}}',

  // Delegation
  delegate: 'Delegate',
  delegateTitle: 'Delegate duty',
  delegateDescription: 'Choose a member to hand off your duty to.',
  delegateSameTeam: 'Your team',
  delegateCrossTeam: 'Other members',
  delegateInstant: 'Instant',
  delegateNeedsConfirm: 'Needs confirmation',
  delegateConfirmTitle: 'Delegate duty?',
  delegateConfirmInstant: 'The duty will be transferred to {{name}} immediately.',
  delegateConfirmPending: '{{name}} will receive a request and must confirm.',
  delegateSuccess: 'Duty delegated successfully.',
  delegatePending: 'Request sent. Waiting for confirmation.',
  delegateRequestTitle: 'Duty request',
  delegateRequestMessage: '{{from}} wants to delegate the {{role}} duty for {{game}} on {{date}} to you.',
  delegateAccept: 'Accept',
  delegateDecline: 'Decline',
  delegateAccepted: 'Duty accepted.',
  delegateDeclined: 'Request declined.',
  delegateExpired: 'Expired',
  delegatePendingOutgoing: 'Request pending for {{name}}',
  searchMember: 'Search name...',
  noMembersFound: 'No matching members found.',
  assignedTo: 'Assigned to {{name}}',

  // Reminder toggle
  reminderEmails: 'Reminder emails',
  reminderEmailsOn: 'ON — Reminders will be sent the day before games',
  reminderEmailsOff: 'OFF — No reminder emails will be sent',

  // Info panel
  infoTitle: 'Scorer duty info',
  infoArrivalTitle: 'Arrival times',
  infoArrivalScorer: 'The Scorer must be in the hall at least <strong>30 minutes</strong> before the start of play.',
  infoArrivalTaefeler: 'The Scoreboard operator must be in the hall at least <strong>15 minutes</strong> before the start of play.',
  infoArrivalReferee: 'The Referee must be in the hall at least <strong>30 minutes</strong> before the start of play.',
  // Per-card arrival hints (/scorer)
  arrivalHintSingle: 'In the hall {{min}} min before the start.',
  arrivalHintReferee: 'Referee: in the hall {{min}} min before the start.',
  arrivalHintSplit: 'Scorer {{scorer}} min · Scoreboard {{board}} min before the start.',
  infoWarningTitle: 'Warning!',
  infoWarningFine: 'Late arrival or failure to appear will result in a fine (CHF 50.–).',
  infoRequirementsTitle: 'Game requirements',
  infoRequirements: 'Games from 4th league and below only need a Scorer, without licence. It is indicated as the only "Scorer/Scoreboard" in the game details.',
  infoRequirementsArrival: 'In this case, the Scorer/Scoreboard must be in the hall at least <strong>30 minutes</strong> before the start of play.',
  infoHowToTitle: 'How to use',
  infoHowTo: 'Click on the game, select your role, select yourself in the dropdown, and confirm. If you don\'t find yourself in the dropdown, contact Luca or Thamy.',

  // Home-team roster (Schreiber only, ±1h around the game)
  viewRoster: 'Roster',
  rosterTitle: 'Home team roster',
  rosterColNumber: '#',
  rosterColName: 'Name',
  rosterColDob: 'Date of birth',
  /** Narrow screens: the full label wraps to two lines in the column. */
  rosterColDobShort: 'DoB',
  rosterEmpty: 'No players found for this team.',
  rosterOutsideWindow: 'The roster is only available from 40 minutes before the game until it ends.',
  rosterNotScorer: 'Only the assigned scorer can view the roster.',
  rosterNotHome: 'The roster is only available for home games.',
  rosterNoTime: 'This game has no scheduled time yet.',
  rosterError: 'Could not load the roster.',
  rosterColLicence: 'Licence',
  rosterSourceVm: 'Einsatzliste from Volleymanager',
  rosterSourceRsvp: 'No Einsatzliste in Volleymanager — confirmed players only',
  rosterNotEligible: 'Not eligible according to Volleymanager',
  rosterNoConfirmed: 'No confirmed players yet.',
  rosterCaptain: 'Captain',
  rosterCaptainShort: 'C',
  rosterCoaches: 'Coaches',
  // Duty banner + emergency (homepage)
  dutyBadge: 'On duty',
  dutyBannerTitle: 'You are on {{role}} duty',
  dutyEmergencyButton: 'Emergency: Contact team leaders',
  dutyEmergencySent: 'Team leaders shown — the club has been notified.',
  dutyEmergencyError: 'Could not send the alert. Please call a team leader directly.',
  dutyEmergencyRevealed: 'Team leaders — contact them now:',
  dutyEmergencyNoLeaders: 'No team leaders on file. Contact Luca or Thamy.',
  roleCoach: 'Coach',
  roleResponsible: 'Team responsible',
} as const
