export default {
  /** Migration 354: trainings_hall_slot_date_uq rejected a concurrent create. */
  duplicateSlotDate: 'Un entraînement existe déjà pour ce créneau de salle à cette date. Actualise et réessaie — quelqu\'un vient peut-être de le créer.',
  title: 'Entrainements',
  subtitle: 'Apercu des entrainements avec suivi des presences',

  // Tabs
  tabTrainings: 'Entrainements',
  tabCoachDashboard: 'Tableau de bord entraineur',

  // Training card
  attendance: 'Presence',
  cancelled: 'Annule',

  // Attendance sheet
  attendanceTitle: 'Presence — {{date}}',
  attendanceTitleShort: 'Presence',
  noPlayers: 'Aucun joueur',
  noPlayersAssigned: 'Aucun joueur n\'a encore ete attribue a cette equipe.',

  // Coach dashboard
  seasonLabel: 'Saison',
  rangeFromLabel: 'De',
  rangeToLabel: 'À',
  resetRange: 'Réinitialiser',
  rangeInvalid: '"De" doit être avant ou égal à "À"',
  noDataAvailable: 'Aucune donnee disponible',
  noDataDescription: 'Aucune donnee de presence a afficher.',

  // Table headers
  playerCol: 'Joueur',
  numberCol: '#',
  trainingsCol: 'Entrainements',
  presentCol: 'Present',
  absentCol: 'Absent',
  rateCol: 'Taux',
  trendCol: 'Tendance',

  // Filter
  showPast: 'Afficher anciens entraînements',
  hidePast: 'Masquer anciens entraînements',

  // Empty states
  noTrainings: 'Aucun entrainement',
  noTrainingsDescription: 'Aucun entrainement trouve pour les filtres selectionnes.',

  // CRUD
  newTraining: 'Nouvel entrainement',
  newSingleTraining: 'Entrainement unique',
  newRecurringTraining: 'Entrainements recurrents',
  editTraining: 'Modifier l\'entrainement',
  deleteTraining: 'Supprimer l\'entrainement',
  deleteConfirm: 'Voulez-vous vraiment supprimer cet entrainement ?',
  cancelTraining: 'Annuler l\'entrainement',
  trainingCancelled: 'Entrainement annule',
  cancelReason: 'Motif d\'annulation',

  // Recurring
  recurringTitle: 'Generer des entrainements recurrents',
  selectSlot: 'Selectionner un creneau de salle',
  dateRange: 'Periode',
  generatePreview: 'Apercu des dates',
  generate: 'Generer',
  trainingsGenerated: '{{count}} entrainements generes',
  trainingsSkipped: '{{count}} ignore(s) (existaient deja)',
  respondBy: 'Repondre avant le',
  respondByHint: 'Rappel 1 jour avant',
  respondByTime: "Heure limite d'inscription",
  respondByHours: 'heures',
  respondByDays: 'jours',
  respondByWeeks: 'semaines',
  respondByMonths: 'mois',
  respondByBefore: 'avant',
  participation: 'Participation',
  minParticipants: 'Min. participants',
  maxParticipants: 'Max. participants',
  untilSeasonEnd: 'Indefiniment',
  slotFrom: 'du',
  slotUntil: 'au',

  // Recurring edit
  editRecurringTitle: 'Modifier l\'entrainement recurrent',
  editRecurringDescription: 'Cet entrainement fait partie d\'une serie recurrente. Que souhaitez-vous modifier ?',
  editThisOnly: 'Cet entrainement uniquement',
  editSameDay: 'Tous les entrainements du meme jour de la semaine',
  editAllRecurring: 'Tous les entrainements recurrents',
  cancelEdit: 'Annuler',

  // Slot mode
  slotDetected: 'Creneau de salle detecte',
  claimedSlot: 'Creneau reclame',
  regularSlot: 'Creneau regulier',
  noSlotForDay: 'Aucun creneau de salle pour ce jour',
  useSlot: 'Utiliser le creneau de salle',
  enterManually: 'Saisir manuellement',
  slotModeAuto: 'Creneau auto',
  slotModeManual: 'Manuel',
  autoCancelOnMin: 'Annulation automatique',
  autoCancelOnMinHint: "L'entraînement sera annulé automatiquement à la date limite si moins de confirmations que le minimum",
  excludedGuestLevels: 'Invités exclus',
  excludedGuestLevelsHint: 'Les invités des niveaux sélectionnés ne peuvent pas confirmer ni se marquer incertains',
  excludeAllGuests: 'Tous les invités',
  guestExcluded: 'Votre niveau d\'invité est exclu de cet entraînement',
  autoConfirmRsvp: 'Confirmation automatique',
  autoConfirmRsvpHint: 'Remplacer la valeur par défaut de l\'équipe ({{default}}). Tous les membres éligibles démarrent confirmés ; ils doivent se désinscrire.',
  useTeamDefault: 'Valeur par défaut de l\'équipe',
  on: 'Activé',
  off: 'Désactivé',
  isTrialTraining: 'Entraînement d\'essai',
  isTrialTrainingHint: 'Visible publiquement sur la page d\'équipe lorsque l\'équipe est ouverte aux nouveaux joueurs.',
  trialBadge: 'Essai',
  shortenedBadge: 'Raccourci',
  shortenedHint: 'Se termine plus tôt — match à domicile dans la salle ensuite',

  // Serie — manuelle (sans creneau de salle)
  weekday: 'Jour de la semaine',
  manualStartTime: 'Heure de debut',
  manualEndTime: 'Heure de fin',
  manualHint: 'Aucun creneau de salle n\'est utilise. Choisissez vous-meme le jour, les horaires et la salle — la serie n\'est liee a aucun creneau, une annulation ne libere donc pas de temps de salle pour les autres equipes.',
  manualEndAfterStart: 'L\'heure de fin doit etre apres l\'heure de debut.',
  noSlotsForTeam: 'Cette equipe n\'a aucun creneau de salle. Passez a la saisie manuelle pour generer quand meme une serie.',
} as const
