export default {
  title: 'Plan de salle',
  subtitleDay: 'Vue journaliere de l\'occupation de la salle',
  subtitleWeek: 'Vue hebdomadaire de l\'occupation de la salle',

  // Slot form
  hall: 'Salle',
  team: 'Equipe',
  searchTeam: 'Chercher une equipe…',
  noTeamFound: 'Aucune equipe trouvee.',
  freeSlot: 'Creneau d\'entrainement libre',
  freeSlotHint: 'Aucune equipe assignee — disponible pour toute equipe',
  dayOfWeek: 'Jour de la semaine',
  slotType: 'Type',
  startTime: 'Heure de debut',
  endTime: 'Heure de fin',
  recurring: 'Recurrent',
  validFrom: 'Valable du',
  validTo: 'Valable au',
  indefinitely: 'Indefiniment',
  label: 'Libelle',
  autoLabel: 'Libelle automatique',
  notes: 'Notes',

  // Slot types
  typeTraining: 'Entrainement',
  typeGame: 'Match',
  typeEvent: 'Evenement',
  typeOther: 'Autre',

  // Day names (full)
  dayMonday: 'Lundi',
  dayTuesday: 'Mardi',
  dayWednesday: 'Mercredi',
  dayThursday: 'Jeudi',
  dayFriday: 'Vendredi',
  daySaturday: 'Samedi',
  daySunday: 'Dimanche',

  // Slot editor
  editSlot: 'Modifier le creneau',
  editSlotTitle: 'Modifier le creneau',
  newSlotTitle: 'Nouveau creneau',
  deleteSlotConfirm: 'Voulez-vous vraiment supprimer ce creneau ?',
  selectPlaceholder: '-- Selectionner --',

  // Validation
  hallRequired: 'Veuillez selectionner une salle',
  dayRequired: 'Veuillez selectionner un jour',
  startTimeRequired: 'L\'heure de debut est requise',
  endTimeRequired: 'L\'heure de fin est requise',

  // Closure manager
  closuresTitle: 'Gerer les fermetures de salle',
  currentClosures: 'Fermetures en cours',
  addNewClosure: 'Ajouter une fermeture',
  editClosure: 'Modifier la fermeture',
  noClosures: 'Aucune fermeture en cours',
  deleteClosureConfirm: 'Voulez-vous vraiment supprimer cette fermeture de salle ?',
  closuresSubtitle: 'Jours ou une salle est fermee. Une fermeture masque la salle dans le plan des salles, apparait dans le calendrier et le flux iCal, bloque les matchs a domicile et annule les entrainements ces jours-la.',
  closuresScopeUpcoming: 'A venir',
  closuresScopeAll: 'Toutes',
  closuresColDates: 'Dates',
  closureAddedToast_one: 'Fermeture ajoutee : {{range}}, 1 salle',
  closureAddedToast_other: 'Fermeture ajoutee : {{range}}, {{count}} salles',
  closureUpdatedToast_one: 'Fermeture mise a jour : {{range}}, 1 salle',
  closureUpdatedToast_other: 'Fermeture mise a jour : {{range}}, {{count}} salles',
  closureDeletedToast: 'Fermeture supprimee',
  closureSyncOwnedWarning: 'Cette source est geree par une synchronisation automatique — une fermeture enregistree ici sera supprimee au prochain passage. Utilisez « Admin » ou « Concierge » pour une fermeture manuelle.',

  // Hall-administration calendar (gcal) — per-entry closure override
  gcalEntriesTitle: 'Calendrier de la gestion des salles',
  gcalEntriesSubtitle: 'Chaque entrée que la gestion des salles inscrit dans ce calendrier ferme les salles KWI. Si une entrée n\'est pas une vraie fermeture — un match ou un entraînement du club saisi par leurs soins —, désactive-la ici; les entraînements annulés redeviennent actifs.',
  gcalEntriesEmpty: 'Aucune entrée à venir de la gestion des salles',
  gcalColEntry: 'Entrée',
  gcalColEffect: 'Effet',
  gcalEffectCloses: 'Ferme les salles',
  gcalEffectOpen: 'Pas de fermeture',
  gcalEffectConfirmed: 'Ferme les salles (confirmé)',
  gcalActionOpen: 'Pas de fermeture',
  gcalActionClose: 'Fermer les salles',
  gcalCloseConfirm: 'Fermer les salles KWI pour cette entrée? Les entraînements de ces jours seront annulés.',
  gcalOverrideOffToast: 'Plus une fermeture',
  gcalOverrideOnToast: 'Salles fermées',
  gcalTrainingsCancelledToast_one: '1 entraînement annulé',
  gcalTrainingsCancelledToast_other: '{{count}} entraînements annulés',
  gcalTrainingsRestoredToast_one: '1 entraînement est de nouveau actif',
  gcalTrainingsRestoredToast_other: '{{count}} entraînements sont de nouveau actifs',

  // Publishing a club closure to the hall administration's calendar
  gcalPushCol: 'Calendrier des salles',
  gcalPushNo: 'Non publié',
  gcalPushYes: 'Publié',
  gcalPushDuplicate: 'Déjà chez eux',
  gcalPushNotEligible: '—',
  gcalPushAction: 'Publier',
  gcalPushRemoveAction: 'Retirer',
  gcalPushConfirm: 'Publier cette fermeture dans le calendrier de la gestion des salles? Elle apparaîtra comme une réservation du KSCW.',
  gcalPushRemoveConfirm: 'Retirer cette fermeture du calendrier de la gestion des salles?',
  gcalPushedToast: 'Publié dans le calendrier des salles',
  gcalPushRemovedToast: 'Retiré du calendrier des salles',
  gcalPushDuplicateToast: 'Non publié — la gestion des salles couvre déjà cette période ({{title}})',
  gcalPushDryRunToast: 'Marqué pour publication (dev tourne à vide — rien n\'a été écrit)',
  gcalPushDisabledToast: 'Marqué, mais la publication du calendrier n\'est pas configurée sur cet environnement',



  // Closure sources
  source: 'Source',
  sourceCaretaker: 'Concierge',
  sourceAdmin: 'Admin',
  sourceAutomatic: 'Automatique',
  sourceGcal: 'Google Calendar',
  sourceSchoolHolidays: 'Vacances scolaires',
  closed: 'Ferme',
  allHalls: 'Toutes les salles',
  halls: 'salles',
  editAppliesToAllHalls: 'La modification s\'applique a {{count}} salles',
  hallsField: 'Salles',
  selectHallsHint: 'Sélectionnez une ou plusieurs salles',
  presetKwi: 'KWI',

  // Navigation
  today: 'Aujourd\'hui',
  closures: 'Fermetures',
  prevWeek: 'Semaine precedente',
  nextWeek: 'Semaine suivante',

  // Summary
  summary: 'Resume',

  // Virtual slots
  typeAway: 'Exterieur',
  autoGenerated: 'Genere automatiquement',
  cancelled: 'Annule',

  // Virtual slot detail labels
  league: 'Ligue',
  start: 'Debut',
  slot: 'Creneau',
  result: 'Resultat',
  location: 'Lieu',
  allDay: 'Toute la journee',
  date: 'Date',
  reason: 'Motif',

  // Game statuses
  statusScheduled: 'Planifie',
  statusLive: 'En direct',
  statusCompleted: 'Termine',
  statusPostponed: 'Reporte',

  // Claim system
  slotFreed: 'Disponible',
  slotClaimed: 'Reclame',
  claimSlotTitle: 'Reclamer du temps de salle',
  claimConfirm: 'Reclamer',
  claimRelease: 'Liberer',
  claimReleaseConfirm: 'Voulez-vous vraiment liberer cette reclamation ?',
  claimAlreadyTaken: 'Ce creneau a deja ete reclame.',
  claimPastDate: 'Les creneaux passes ne peuvent pas etre reclames.',
  claimTeamLabel: 'Pour l\'equipe',
  claimReasonCancelled: 'Entrainement annule',
  claimReasonAway: 'Match a l\'exterieur',
  claimReasonSpielhalle: 'Salle de match',
  claimOriginalTeam: 'A l\'origine',
  claimClaimedBy: 'Reclame par',
  claimClaimedAt: 'Reclame le',
  claimNotes: 'Notes',
  claimSuccess: 'Creneau reclame avec succes !',
  claimReleased: 'Reclamation liberee.',
  claimDetailTitle: 'Details de la reclamation',

  // Filter
  vbOnly: 'VB uniquement',
  all: 'Tout',

  // Admin navigation
  updateFutureTrainings: 'Mettre a jour les entrainements futurs',
  goToTrainings: 'Aller aux entrainements',
  goToGames: 'Aller aux matchs',

  // Available slots
  slotsAvailable: '{{count}} creneau(x) disponible(s)',
  slotsAvailableTitle: 'Creneaux disponibles',
  slotsAvailableNone: 'Aucun creneau disponible',

  // Abreviations des jours (en-tetes de grille / resume)
  dayMonShort: 'Lun',
  dayTueShort: 'Mar',
  dayWedShort: 'Mer',
  dayThuShort: 'Jeu',
  dayFriShort: 'Ven',
  daySatShort: 'Sam',
  daySunShort: 'Dim',

  // Finitions grille / editeur
  noDataToDisplay: 'Aucune donnee a afficher',
  breakExpand: 'Rien de reserve {{from}}–{{to}} — cliquer pour afficher ces heures',
  switchOverlap: 'Alterner le chevauchement',
  labelPlaceholder: 'p.ex. Entrainement d\'essai, Match a domicile vs. TVA',
  sportVolleyball: 'Volleyball',
  sportBasketball: 'Basketball',
  claimNotesPlaceholder: 'Optionnel…',
  closureReasonPlaceholder: 'p.ex. Vacances, entretien, renovation',

  // Registre des salles (/admin/hallenplan/halls)
  hallsNav: 'Salles',
  hallsTitle: 'Gerer les salles',
  hallsSubtitle: 'Les lieux vers lesquels pointent chaque creneau, entrainement et match a domicile. Une salle doit exister ici avant qu\'une equipe puisse y recevoir un creneau.',
  addNewHall: 'Ajouter une salle',
  editHall: 'Modifier la salle',
  hallName: 'Nom',
  hallNameHint: 'Choisir un lieu connu pour reprendre l\'adresse, ou simplement saisir un nom.',
  hallNamePlaceholder: 'p.ex. KWI A',
  hallAddress: 'Adresse',
  hallCity: 'Localite',
  hallCourts: 'Terrains',
  hallMapsUrl: 'Lien carte',
  hallHomologation: 'Homologuee',
  hallHomologationHint: 'Autorisee pour les matchs de championnat',
  hallNameRequired: 'Veuillez saisir un nom de salle',
  hallSaved: 'Salle enregistree',
  hallDeleted: 'Salle supprimee',
  hallDeleteConfirm: 'Supprimer "{{name}}" ? Cette action est irreversible.',
  hallsEmpty: 'Aucune salle',
  hallImpactRemoved: 'Supprime avec elle :',
  hallImpactKept: 'Conserve, mais sans salle :',
  hallImpactSlots: '{{count}} creneau(x) de salle',
  hallImpactClosures: '{{count}} fermeture(s)',
  hallImpactTrainings: '{{count}} entrainement(s)',
  hallImpactGames: '{{count}} match(s)',
  hallImpactUnknown: 'Impossible de verifier ce qui depend de cette salle.',
} as const
