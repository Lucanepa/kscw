export default {
  title: 'Fines',
  subtitle: 'Open, paid and waived fines',
  empty: 'No fines yet',
  emptyMember: 'No fines for you',

  // Table
  colMember: 'Member',
  colCategory: 'Category',
  colAmount: 'Amount',
  colStatus: 'Status',
  colIssued: 'Issued',
  colTeam: 'Team',
  colActions: 'Actions',
  colReason: 'Reason',

  // Status
  statusOpen: 'Open',
  statusPaid: 'Paid',
  statusWaived: 'Waived',

  // Categories
  categoryLateSignin: 'Late sign-in',
  categoryNoShow: 'No-show',
  categoryLatePayment: 'Late payment',
  categoryCustom: 'Custom',

  // Reset windows
  windowMonth: 'Calendar month',
  window30d: 'Rolling 30 days',
  window90d: 'Rolling 90 days',
  windowSeason: 'Season (Sep–Aug)',
  windowNever: 'Lifetime',
  // Inline phrases (for preview line)
  thisMonth: 'this month',
  last30Days: 'in the last 30 days',
  last90Days: 'in the last 90 days',
  thisSeason: 'this season',
  allTime: 'all time',

  // Issue / waive / pay
  issueFine: 'Issue fine',
  issueFineFor: 'Issue fine — {{name}}',
  issueFineSubmit: 'Issue fine',
  issueFineSuccess: 'Fine issued',
  issueFineError: 'Could not issue fine: {{error}}',
  pickTeamPlaceholder: 'Select a team…',
  pickTeamFirst: 'Select a team first',
  pickMemberPlaceholder: 'Select a member…',
  pickContinue: 'Continue',
  // Team-level fines (migration 350) — owed by the team, not an individual.
  targetLabel: 'Who is being fined?',
  targetMember: 'A member',
  targetTeam: 'The whole team',
  targetTeamHint: 'The team owes this one — nobody\'s personal balance changes. Escalation tiers do not apply, so enter the amount yourself.',
  issueFineForTeam: 'Issue fine — {{name}} (team)',
  teamFineRow: 'Whole team',
  amountPlaceholderTeam: 'Enter the amount',
  markPaid: 'Mark as paid',
  markPaidTitle: 'Mark fine as paid',
  markPaidSuccess: 'Marked as paid',
  waive: 'Waive',
  waiveTitle: 'Waive fine',
  waiveReasonLabel: 'Reason for waiving',
  waiveReasonRequired: 'Please give a short reason.',
  waiveSubmit: 'Waive fine',
  waiveSuccess: 'Fine waived',

  // Form fields
  categoryLabel: 'Category',
  amountLabel: 'Amount (CHF)',
  amountPlaceholder: 'Auto from rule, or enter manually',
  reasonLabel: 'Reason',
  reasonPlaceholder: 'Short note (visible to the member)',
  activityLabel: 'Related activity (optional)',
  payMethodLabel: 'Payment method',
  payMethodCash: 'Cash',
  payMethodTwint: 'TWINT',
  payMethodTransfer: 'Bank transfer',
  payMethodOther: 'Other',
  payToLabel: 'Paid to',
  payToTeamKasse: 'Team Kasse',
  payToClubKasse: 'Club Kasse',

  // Engine preview
  previewLine: '{{ordinal}} {{categoryLabel}} {{window}} → {{amount}}',
  previewNoRule: 'No rule configured for this category. Enter an amount manually.',
  previewError: 'Could not compute amount — enter manually.',

  // Profile strip
  outstanding: 'Outstanding: {{amount}}',
  outstandingCount_one: '{{count}} open fine',
  outstandingCount_other: '{{count}} open fines',
  outstandingNone: 'No open fines',
  outstandingView: 'View',

  // Late-confirm prompt
  lateConfirmTitle: 'Late confirmation',
  lateConfirmBody: '{{name}} confirmed past the deadline. Issue a fine?',
  lateConfirmApply: 'Issue {{amount}}',
  lateConfirmSkip: 'Skip',

  // Settings
  settingsTitle: 'Fines',
  settingsDescription: 'Escalation tiers and reset windows per category.',
  settingsEnabled: 'Enabled',
  settingsLateSigninSweep: 'While this is on, anyone who has not answered by the deadline is marked as not coming and fined automatically the next morning.',
  settingsResetWindow: 'Reset window',
  settingsTiers: 'Escalation tiers',
  settingsAddTier: 'Add tier',
  settingsRemoveTier: 'Remove',
  settingsTierOffense: 'Offense #',
  settingsTierOffenseMin: 'From offense #',
  settingsTierAmount: 'CHF',
  settingsLastIsMin: 'Last tier covers this offense and all higher.',
  settingsPreview: 'Preview',
  settingsNoTiers: 'No tiers yet.',
  settingsSaved: 'Saved',
  settingsSaveError: 'Could not save: {{error}}',

  // Dashboard widget
  dashboardTitle: 'Fines this month',
  dashboardTotalOpen: 'Open this month',
  dashboardCount_one: '{{count}} fine',
  dashboardCount_other: '{{count}} fines',
  dashboardCompareUp: '+{{delta}} vs. last month',
  dashboardCompareDown: '-{{delta}} vs. last month',
  dashboardCompareSame: 'Same as last month',
  dashboardViewAll: 'View all',

  // Filters
  filterAll: 'All',
  filterTeam: 'Team',
  filterStatus: 'Status',
  filterMine: 'My fines',

  // Ordinals
  ordinal: '{{n}}.',  // Swiss-style: "1.", "2.", "3." — works in EN too as "1st" alternative
  ordinal1st: '1st',
  ordinal2nd: '2nd',
  ordinal3rd: '3rd',
  ordinalNth: '{{n}}th',

  // Home card (own open fines + the team fines the Teamkasse owes)
  homeCardTitle: 'Open fines',
  homeCardMine_one: 'Yours: {{amount}} ({{count}} fine)',
  homeCardMine_other: 'Yours: {{amount}} ({{count}} fines)',
  homeCardTeamOwes: '{{team}} owes {{amount}} as a team',
}
