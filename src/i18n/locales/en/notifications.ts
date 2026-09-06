export default {
  title: 'Notifications',
  markAllRead: 'Mark all read',
  clearRead: 'Clear read',
  delete: 'Delete',
  noNotifications: 'No new notifications.',
  news: 'News',
  showAll: 'Show all',
  // Type labels
  activityChange: 'Activity',
  upcomingActivity: 'Upcoming',
  deadlineReminder: 'Deadline',
  resultAvailable: 'Result',
  dutyDelegation: 'Scorer duty',
  memberJoinRequest: 'Join request',
  expenseStatus: 'Expense',
  announcement: 'Club news',
  eventInvite: 'Event invitation',
  newReport: 'Report',
  member_join_request: '{{memberName}} wants to join {{teamName}}',
  expense_paid: 'Your expense of {{amount}} has been paid.',
  expense_rejected: 'Your expense of {{amount}} was rejected.',
  // Delegation notification messages
  duty_delegation_request: '{{from}} wants to delegate the {{role}} duty for {{game}} on {{date}} to you.',
  duty_delegation_accepted: '{{to}} accepted the {{role}} duty for {{game}}.',
  duty_delegation_declined: '{{to}} declined the duty request for {{game}}.',
  // Notification messages (keys stored in DB title field, interpolated with body JSON)
  game_created: 'New game: {{home_team}} vs {{away_team}} on {{date}}',
  game_updated: 'Game updated: {{home_team}} vs {{away_team}} on {{date}}',
  game_deleted: 'Game cancelled: {{home_team}} vs {{away_team}} on {{date}}',
  game_reinstated: 'Game back on: {{home_team}} vs {{away_team}} on {{date}}',
  game_result: 'Result: {{home_team}} {{home_score}}:{{away_score}} {{away_team}}',
  game_invite: '{{team}} called you up: {{matchup}} on {{date}}',
  training_created: 'New training on {{date}}, {{time}} @ {{hall}}',
  training_updated: 'Training updated on {{date}} @ {{hall}}',
  training_cancelled: 'Training cancelled on {{date}}',
  training_deleted: 'Training deleted on {{date}}',
  event_created: 'New event: {{title}}',
  form_published: 'New form: {{title}}',
  form_submission: 'New response: {{title}}',
  form_reminder: 'Reminder — please fill in: {{title}}',
  event_updated: 'Event updated: {{title}}',
  event_deleted: 'Event cancelled: {{title}}',
  upcoming_game: '{{home_team}} vs {{away_team}} at {{hall}} on {{date}} {{time}}',
  upcoming_game_no_hall: '{{home_team}} vs {{away_team}} on {{date}} {{time}}',
  upcoming_training: 'Training at {{hall}} on {{date}} {{time}}',
  upcoming_training_no_hall: 'Training on {{date}} {{time}}',
  upcoming_event: '{{title}} at {{location}} on {{date}} {{time}}',
  upcoming_event_no_hall: '{{title}} on {{date}} {{time}}',
  deadline_game: 'RSVP deadline tomorrow: {{home_team}} vs {{away_team}}',
  deadline_training: 'RSVP deadline tomorrow: Training on {{date}} @ {{hall}}',
  deadline_event: 'RSVP deadline tomorrow: {{title}}',
  // New feature notifications
  poll_created: '{{creator}} created a poll: {{question}}',
  new_report: 'New report: {{reason}}',
  absence_created_for_you: '{{editor}} added an absence for you (from {{start}})',
  absence_updated_for_you: '{{editor}} updated your absence (from {{start}})',
  absence_weekly_created_for_you: '{{editor}} added a weekly unavailability for you',
  absence_weekly_updated_for_you: '{{editor}} updated your weekly unavailability',
  // Type labels for new features
  pollCreated: 'Poll',
  // Push notifications
  pushNotifications: 'Push notifications',
  pushEnable: 'Enable',
  pushDisable: 'Disable',
  pushDenied: 'Push notifications are blocked in your browser settings.',
  pushNotSupported: 'Push notifications are not supported by this browser.',
  pushErrorBrave: 'Brave blocks push services. Enable "Use Google Services for Push Messaging" in brave://settings/privacy.',
  pushErrorGeneric: 'Push service unreachable. Check your browser settings or try Chrome/Firefox.',
  pushSubscribeFailed: 'Could not enable push notifications.',
  pushUnsubscribeFailed: 'Could not disable push notifications.',
  // Unread badge (aria-labels)
  unreadShort_one: '{{count}} unread',
  unreadShort_other: '{{count}} unread',
  unreadBadge_one: '{{count}} unread notification',
  unreadBadge_other: '{{count}} unread notifications',
  // Time helpers
  justNow: 'just now',
  minutesAgo: '{{count}}m ago',
  hoursAgo: '{{count}}h ago',
  daysAgo: '{{count}}d ago',
  // Licence status (migration 301). `licenceStatus` is the category chip;
  // `licence_status_changed` is the message body — the row stores this key as
  // its title and a {status, season} bag as its body, so the bell renders in
  // the READER's language, not the sender's.
  licenceStatus: 'Licence',
  licence_status_changed: 'Your licence status for {{season}} is now: {{status}}',

  // Fines (migration 069 / team fines migration 350). The row stores the key as
  // its title and a {team, amount, reason} bag as its body, so the bell renders
  // in the READER's language. Untranslated until 2026-09-02 — the bell showed
  // the raw key.
  fineLabel: 'Fine',
  fine_issued: 'New fine from {{team}}: {{amount}}',
  fine_paid: 'Your fine of {{amount}} ({{team}}) is marked as paid',
  fine_waived: 'Your fine of {{amount}} ({{team}}) was waived',
  team_fine_issued: '{{team}} was fined {{amount}} as a team',
  team_fine_paid: 'The team fine of {{amount}} ({{team}}) is marked as paid',
  team_fine_waived: 'The team fine of {{amount}} ({{team}}) was waived',

  // Deadline sweep (migration 352). The daily cron declines a member who never
  // answered before respond_by and — where the team's late_signin rule is on —
  // fines them for it. Same storage shape as the fines rows above: the key
  // lives in `title`, a {team, date, amount} bag in `body`, so the bell renders
  // in the READER's language rather than the cron's.
  deadlineMissed: 'Deadline missed',
  auto_declined_deadline: 'You missed the sign-up deadline for {{date}} ({{team}}) — marked as not coming',
  auto_declined_deadline_fined: 'You missed the sign-up deadline for {{date}} ({{team}}) — marked as not coming, fine {{amount}}',
} as const
