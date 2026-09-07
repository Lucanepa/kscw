export default {
  title: 'Service de marqueur',
  subtitle: 'Gerer les attributions de marqueur et de tableau d\'affichage pour les matchs a domicile.',

  // Tabs
  tabGames: 'Matchs',
  tabOverview: 'Vue d\'ensemble',
  dutyScopeAll: 'Tous',
  dutyScopeMine: 'Sélectionnés',

  // Labels — Volleyball
  scorer: 'Marqueur',
  scoreboard: 'Tableau d\'affichage',
  scorerTaefeler: 'Marqueur/Tableau',
  referee: 'Arbitre',
  confirmed: 'Confirme',

  // Labels — Basketball
  bbScorer: 'Marqueur (OTR1)',
  bbTimekeeper: 'Chronometreur (OTR1)',
  bb24sOfficial: 'Officiel 24" (OTR2)',
  bbDutyTeam: 'Equipe d\'officiels',

  // Sport toggle
  sportVolleyball: 'Volleyball',
  sportBasketball: 'Basketball',
  officialsDuties: 'Officiels',
  dutyTeam: 'Equipe de service',

  // Status labels
  statusConfirmed: 'Confirme',
  statusAssigned: 'Attribue',
  statusOpen: 'Ouvert',
  confirmedBy: 'Confirmé par',

  // Filters
  filters: 'Filtres',
  filterDate: 'Date',
  filterDutyTeam: 'Equipe de service',
  filterPlayingTeam: 'Équipe qui joue',
  overviewByTeam: 'Par équipe de service',
  overviewByGame: 'Par match',
  overviewColTeam: 'Équipe',
  overviewColDuties: 'Services',
  overviewColOpen: 'Ouverts',
  filterDutyType: 'Type de service',
  filterUnassigned: 'Service non attribue',
  filterSearchAssignee: 'Rechercher un responsable',
  filterAllTeams: 'Toutes les equipes',
  filterAllTypes: 'Tous les types',
  filterAllDuties: 'Tous les services',
  filterAnyUnassigned: 'Tout non attribue',
  searchAssigneePlaceholder: 'Rechercher des responsables...',
  clearFilters: 'Effacer les filtres',

  // Empty state
  noGames: 'Aucun match',
  noGamesDescription: 'Aucun match trouve pour le filtre selectionne.',
  noPastGamesThisSeason: 'Aucun match passé cette saison',

  // Error toasts
  errorUpdate: 'Impossible de mettre a jour l\'attribution.',
  errorToggleReminders: 'Impossible de modifier le parametre de rappel.',
  errorDelegate: 'Impossible d\'envoyer la delegation.',
  errorAcceptDelegation: 'Impossible d\'accepter la demande.',
  errorDeclineDelegation: 'Impossible de refuser la demande.',

  // Past games
  showOlderGames: 'Afficher les anciens matchs',
  loadMore: 'Charger plus',
  hidePast: 'Masquer les anciens matchs',

  // Actions
  exportICal: 'Ajouter au calendrier',
  unassigned: 'Non attribue',
  unconfirm: 'Annuler la confirmation',
  hide: 'Masquer',

  // Self-assign
  selfAssign: 'M\'inscrire',
  selfAssignSuccess: 'Inscrit — à bientôt !',
  selfAssignError: 'Inscription impossible — déjà pris, ou tu n\'es pas éligible.',
  confirmSelfAssignTitle: 'Confirmer l\'attribution',
  confirmSelfAssignMessage: 'Vous vous inscrivez en tant que <strong>{{role}}</strong> pour <strong>{{game}}</strong> le <strong>{{date}}</strong>.',
  confirmSelfAssignArrival_scorer: 'Vous devez etre dans la salle au moins <strong>30 minutes</strong> avant le debut du match.',
  confirmSelfAssignArrival_scoreboard: 'Vous devez etre dans la salle au moins <strong>10 minutes</strong> avant le debut du match.',
  confirmSelfAssignArrival_scorer_scoreboard: 'Vous devez etre dans la salle au moins <strong>30 minutes</strong> avant le debut du match.',
  confirmSelfAssignArrival_referee: 'Vous devez etre dans la salle au moins <strong>30 minutes</strong> avant le debut du match.',
  confirmSelfAssignArrival_bb: 'Vous devez etre dans la salle au moins <strong>15 minutes</strong> avant le debut du match.',
  confirmSelfAssignWarning: 'Ce choix est <strong>définitif</strong>. Une fois une tâche acceptée, tu ne peux plus l\'abandonner — le seul moyen de t\'en défaire est de la <strong>déléguer à un autre membre</strong>.',
  confirmSelfAssignAbsence: 'Tu as une absence enregistrée à cette date. Tu peux quand même prendre le service, mais vérifie d\'abord ta disponibilité.',
  cancelAction: 'Annuler',
  confirmAction: 'Confirmer',

  // Placeholders
  selectTeam: 'Selectionner l\'equipe',
  selectPerson: 'Selectionner la personne',
  pickDutyTeamTitle: 'Quelle équipe de service ?',
  pickDutyTeamBody: '{{name}} fait partie de plusieurs équipes — choisissez celle qui couvre ce service.',

  // Overview
  overviewEmpty: 'Aucune attribution trouvee.',
  dutyCount: '{{count}} services',

  // Permissions
  permissionsNotice: 'Les attributions de marqueur ne peuvent etre gerees que par les admins et les entraineurs.',

  // iCal export
  scorerDutyIcal: 'Service de marqueur : {{home}} vs {{away}}',

  // Delegation
  delegate: 'Deleguer',
  delegateTitle: 'Deleguer le service',
  delegateDescription: 'Choisissez un membre a qui transmettre votre service.',
  delegateSameTeam: 'Votre equipe',
  delegateCrossTeam: 'Autres membres',
  delegateInstant: 'Immediat',
  delegateNeedsConfirm: 'Confirmation requise',
  delegateConfirmTitle: 'Deleguer le service ?',
  delegateConfirmInstant: 'Le service sera transfere a {{name}} immediatement.',
  delegateConfirmPending: '{{name}} recevra une demande et devra confirmer.',
  delegateSuccess: 'Service delegue avec succes.',
  delegatePending: 'Demande envoyee. En attente de confirmation.',
  delegateRequestTitle: 'Demande de service',
  delegateRequestMessage: '{{from}} souhaite vous deleguer le service de {{role}} pour {{game}} le {{date}}.',
  delegateAccept: 'Accepter',
  delegateDecline: 'Refuser',
  delegateAccepted: 'Service accepte.',
  delegateDeclined: 'Demande refusee.',
  delegateExpired: 'Expire',
  delegatePendingOutgoing: 'Demande en attente pour {{name}}',
  searchMember: 'Rechercher un nom...',
  noMembersFound: 'Aucun membre correspondant trouve.',
  assignedTo: 'Attribue a {{name}}',

  // Reminder toggle
  reminderEmails: 'Emails de rappel',
  reminderEmailsOn: 'ACTIVE — Des rappels seront envoyes la veille des matchs',
  reminderEmailsOff: 'DESACTIVE — Aucun email de rappel ne sera envoye',

  // Info panel
  infoTitle: 'Infos sur le service de marqueur',
  infoArrivalTitle: 'Heures d\'arrivee',
  infoArrivalScorer: 'Le marqueur doit etre dans la salle au moins <strong>30 minutes</strong> avant le debut du match.',
  infoArrivalTaefeler: 'L\'operateur du tableau d\'affichage doit etre dans la salle au moins <strong>15 minutes</strong> avant le debut du match.',
  infoArrivalReferee: 'L\'arbitre doit etre dans la salle au moins <strong>30 minutes</strong> avant le debut du match.',
  // Rappels d\'arrivee par carte (/scorer)
  arrivalHintSingle: 'Dans la salle {{min}} min avant le debut.',
  arrivalHintReferee: 'Arbitre : dans la salle {{min}} min avant le debut.',
  arrivalHintSplit: 'Marqueur {{scorer}} min · Tableau {{board}} min avant le debut.',
  infoWarningTitle: 'Attention !',
  infoWarningFine: 'Un retard ou une absence entrainera une amende (CHF 50.–).',
  infoRequirementsTitle: 'Exigences pour les matchs',
  infoRequirements: 'Les matchs de 4e ligue et inferieures ne necessitent qu\'un marqueur, sans licence. Il est indique comme seul "Marqueur/Tableau" dans les details du match.',
  infoRequirementsArrival: 'Dans ce cas, le marqueur/tableau doit etre dans la salle au moins <strong>30 minutes</strong> avant le debut du match.',
  infoHowToTitle: 'Mode d\'emploi',
  infoHowTo: 'Cliquez sur le match, selectionnez votre role, selectionnez-vous dans le menu deroulant et confirmez. Si vous ne vous trouvez pas dans le menu deroulant, contactez Luca ou Thamy.',

  // Composition de l'equipe a domicile (marqueur uniquement, ±1h autour du match)
  viewRoster: 'Composition',
  rosterTitle: 'Composition de l\'equipe a domicile',
  rosterColNumber: '#',
  rosterColName: 'Nom',
  rosterColDob: 'Date de naissance',
  /** Narrow screens: the full label wraps to two lines in the column. */
  rosterColDobShort: 'Naiss.',
  rosterEmpty: 'Aucun joueur trouve pour cette equipe.',
  rosterOutsideWindow: 'La composition n\'est disponible que de 40 minutes avant le match jusqu\'a la fin.',
  rosterNotScorer: 'Seul le marqueur designe peut voir la composition.',
  rosterNotHome: 'La composition n\'est disponible que pour les matchs a domicile.',
  rosterNoTime: 'Ce match n\'a pas encore d\'horaire defini.',
  rosterError: 'Impossible de charger la composition.',
  rosterColLicence: 'Licence',
  rosterSourceVm: 'Liste d\'engagement de Volleymanager',
  rosterSourceRsvp: 'Aucune liste dans Volleymanager — joueurs confirmés uniquement',
  rosterNotEligible: 'Non qualifié selon Volleymanager',
  rosterNoConfirmed: 'Aucun joueur confirme pour le moment.',
  rosterCaptain: 'Capitaine',
  rosterCaptainShort: 'C',
  rosterCoaches: 'Entraineurs',
  // Duty banner + emergency (homepage)
  dutyBadge: 'De service',
  dutyBannerTitle: 'Tu es de service {{role}}',
  dutyEmergencyButton: 'Urgence : contacter les responsables',
  dutyEmergencySent: 'Responsables affichés — le club a été prévenu.',
  dutyEmergencyError: 'Impossible d\'envoyer l\'alerte. Appelle un responsable directement.',
  dutyEmergencyRevealed: 'Responsables d\'équipe — contacte-les maintenant :',
  dutyEmergencyNoLeaders: 'Aucun responsable enregistré. Contacte Luca ou Thamy.',
  roleCoach: 'Entraîneur',
  roleResponsible: 'Responsable d\'équipe',
} as const
