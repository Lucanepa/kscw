export default {
  title: 'Servizio segnapunti',
  subtitle: 'Gestisci le assegnazioni di segnapunti e tabellone per le partite in casa.',

  // Tabs
  tabGames: 'Partite',
  tabOverview: 'Panoramica',
  dutyScopeAll: 'Tutte',
  dutyScopeMine: 'Selezionate',

  // Labels — Volleyball
  scorer: 'Segnapunti',
  scoreboard: 'Tabellone',
  scorerTaefeler: 'Segnapunti/Tabellone',
  referee: 'Arbitro',
  confirmed: 'Confermato',

  // Labels — Basketball
  bbScorer: 'Segnapunti (OTR1)',
  bbTimekeeper: 'Cronometrista (OTR1)',
  bb24sOfficial: 'Ufficiale 24" (OTR2)',
  bbDutyTeam: 'Squadra ufficiali',

  // Sport toggle
  sportVolleyball: 'Pallavolo',
  sportBasketball: 'Pallacanestro',
  officialsDuties: 'Ufficiali',
  dutyTeam: 'Squadra di turno',

  // Status labels
  statusConfirmed: 'Confermato',
  statusAssigned: 'Assegnato',
  statusOpen: 'Aperto',
  confirmedBy: 'Confermato da',

  // Filters
  filters: 'Filtri',
  filterDate: 'Data',
  filterDutyTeam: 'Squadra di turno',
  filterPlayingTeam: 'Squadra che gioca',
  overviewByTeam: 'Per squadra di turno',
  overviewByGame: 'Per partita',
  overviewColTeam: 'Squadra',
  overviewColDuties: 'Turni',
  overviewColOpen: 'Aperti',
  filterDutyType: 'Tipo di servizio',
  filterUnassigned: 'Servizio non assegnato',
  filterSearchAssignee: 'Cerca assegnatario',
  filterAllTeams: 'Tutte le squadre',
  filterAllTypes: 'Tutti i tipi',
  filterAllDuties: 'Tutti i servizi',
  filterAnyUnassigned: 'Qualsiasi non assegnato',
  searchAssigneePlaceholder: 'Cerca assegnatari...',
  clearFilters: 'Cancella filtri',

  // Empty state
  noGames: 'Nessuna partita',
  noGamesDescription: 'Nessuna partita trovata per il filtro selezionato.',
  noPastGamesThisSeason: 'Nessuna partita passata in questa stagione',

  // Error toasts
  errorUpdate: 'Impossibile aggiornare l\'assegnazione.',
  errorToggleReminders: 'Impossibile modificare l\'impostazione dei promemoria.',
  errorDelegate: 'Impossibile inviare la delega.',
  errorAcceptDelegation: 'Impossibile accettare la richiesta.',
  errorDeclineDelegation: 'Impossibile rifiutare la richiesta.',

  // Past games
  showOlderGames: 'Mostra partite precedenti',
  loadMore: 'Carica altro',
  hidePast: 'Nascondi partite precedenti',

  // Actions
  exportICal: 'Aggiungi al calendario',
  unassigned: 'Non assegnato',
  unconfirm: 'Annulla conferma',
  hide: 'Nascondi',

  // Self-assign
  selfAssign: 'Mi iscrivo',
  selfAssignSuccess: 'Iscritto — a presto!',
  selfAssignError: 'Iscrizione non riuscita (forse già preso o non idoneo).',
  confirmSelfAssignTitle: 'Conferma assegnazione',
  confirmSelfAssignMessage: 'Ti stai iscrivendo come <strong>{{role}}</strong> per <strong>{{game}}</strong> del <strong>{{date}}</strong>.',
  confirmSelfAssignArrival_scorer: 'Devi essere in palestra almeno <strong>30 minuti</strong> prima dell\'inizio del gioco.',
  confirmSelfAssignArrival_scoreboard: 'Devi essere in palestra almeno <strong>10 minuti</strong> prima dell\'inizio del gioco.',
  confirmSelfAssignArrival_scorer_scoreboard: 'Devi essere in palestra almeno <strong>30 minuti</strong> prima dell\'inizio del gioco.',
  confirmSelfAssignArrival_referee: 'Devi essere in palestra almeno <strong>30 minuti</strong> prima dell\'inizio del gioco.',
  confirmSelfAssignArrival_bb: 'Devi essere in palestra almeno <strong>15 minuti</strong> prima dell\'inizio del gioco.',
  confirmSelfAssignWarning: 'Questa scelta è <strong>definitiva</strong>. Una volta presa una mansione non puoi più lasciarla — l\'unico modo per cederla è <strong>delegarla a un altro membro</strong>.',
  confirmSelfAssignAbsence: 'Hai un\'assenza registrata in questa data. Puoi comunque assumere il servizio, ma controlla prima la tua disponibilità.',
  cancelAction: 'Annulla',
  confirmAction: 'Conferma',

  // Placeholders
  selectTeam: 'Seleziona squadra',
  selectPerson: 'Seleziona persona',
  pickDutyTeamTitle: 'Quale squadra di turno?',
  pickDutyTeamBody: '{{name}} fa parte di più squadre — scegli quella che copre questo turno.',

  // Overview
  overviewEmpty: 'Nessuna assegnazione trovata.',
  dutyCount: '{{count}} servizi',

  // Permissions
  permissionsNotice: 'Le assegnazioni del segnapunti possono essere gestite solo da admin e allenatori.',

  // iCal export
  scorerDutyIcal: 'Servizio segnapunti: {{home}} vs {{away}}',

  // Delegation
  delegate: 'Delega',
  delegateTitle: 'Delega servizio',
  delegateDescription: 'Scegli un membro a cui passare il tuo servizio.',
  delegateSameTeam: 'La tua squadra',
  delegateCrossTeam: 'Altri membri',
  delegateInstant: 'Immediato',
  delegateNeedsConfirm: 'Richiede conferma',
  delegateConfirmTitle: 'Delegare il servizio?',
  delegateConfirmInstant: 'Il servizio verrà trasferito immediatamente a {{name}}.',
  delegateConfirmPending: '{{name}} riceverà una richiesta e dovrà confermare.',
  delegateSuccess: 'Servizio delegato con successo.',
  delegatePending: 'Richiesta inviata. In attesa di conferma.',
  delegateRequestTitle: 'Richiesta di servizio',
  delegateRequestMessage: '{{from}} vuole delegare il servizio {{role}} per {{game}} del {{date}} a te.',
  delegateAccept: 'Accetta',
  delegateDecline: 'Rifiuta',
  delegateAccepted: 'Servizio accettato.',
  delegateDeclined: 'Richiesta rifiutata.',
  delegateExpired: 'Scaduta',
  delegatePendingOutgoing: 'Richiesta in attesa per {{name}}',
  searchMember: 'Cerca nome...',
  noMembersFound: 'Nessun membro corrispondente trovato.',
  assignedTo: 'Assegnato a {{name}}',

  // Reminder toggle
  reminderEmails: 'Email promemoria',
  reminderEmailsOn: 'ON — I promemoria verranno inviati il giorno prima della partita',
  reminderEmailsOff: 'OFF — Non verranno inviate email promemoria',

  // Info panel
  infoTitle: 'Info servizio segnapunti',
  infoArrivalTitle: 'Orari di arrivo',
  infoArrivalScorer: 'Il segnapunti deve essere in palestra almeno <strong>30 minuti</strong> prima dell\'inizio del gioco.',
  infoArrivalTaefeler: 'L\'addetto al tabellone deve essere in palestra almeno <strong>15 minuti</strong> prima dell\'inizio del gioco.',
  infoArrivalReferee: 'L\'arbitro deve essere in palestra almeno <strong>30 minuti</strong> prima dell\'inizio del gioco.',
  // Promemoria di arrivo per scheda (/scorer)
  arrivalHintSingle: 'In palestra {{min}} min prima dell\'inizio.',
  arrivalHintReferee: 'Arbitro: in palestra {{min}} min prima dell\'inizio.',
  arrivalHintSplit: 'Segnapunti {{scorer}} min · Tabellone {{board}} min prima dell\'inizio.',
  infoWarningTitle: 'Attenzione!',
  infoWarningFine: 'L\'arrivo in ritardo o la mancata comparsa comporteranno una multa (CHF 50.–).',
  infoRequirementsTitle: 'Requisiti per le partite',
  infoRequirements: 'Le partite dalla 4a lega in giù necessitano solo di un segnapunti, senza licenza. È indicato come unico "Segnapunti/Tabellone" nei dettagli della partita.',
  infoRequirementsArrival: 'In questo caso, il segnapunti/tabellone deve essere in palestra almeno <strong>30 minuti</strong> prima dell\'inizio del gioco.',
  infoHowToTitle: 'Come funziona',
  infoHowTo: 'Clicca sulla partita, seleziona il tuo ruolo, selezionati nel menu a tendina e conferma. Se non ti trovi nel menu a tendina, contatta Luca o Thamy.',

  // Formazione squadra di casa (solo segnapunti, ±1h attorno alla partita)
  viewRoster: 'Formazione',
  rosterTitle: 'Formazione squadra di casa',
  rosterColNumber: '#',
  rosterColName: 'Nome',
  rosterColDob: 'Data di nascita',
  /** Narrow screens: the full label wraps to two lines in the column. */
  rosterColDobShort: 'Nascita',
  rosterEmpty: 'Nessun giocatore trovato per questa squadra.',
  rosterOutsideWindow: 'La formazione è disponibile solo da 40 minuti prima della partita fino alla fine.',
  rosterNotScorer: 'Solo il segnapunti designato può vedere la formazione.',
  rosterNotHome: 'La formazione è disponibile solo per le partite in casa.',
  rosterNoTime: 'Questa partita non ha ancora un orario stabilito.',
  rosterError: 'Impossibile caricare la formazione.',
  rosterColLicence: 'Licenza',
  rosterSourceVm: 'Lista di gara da Volleymanager',
  rosterSourceRsvp: 'Nessuna lista in Volleymanager — solo giocatori confermati',
  rosterNotEligible: 'Non schierabile secondo Volleymanager',
  rosterNoConfirmed: 'Nessun giocatore confermato al momento.',
  rosterCaptain: 'Capitano',
  rosterCaptainShort: 'C',
  rosterCoaches: 'Allenatori',
  // Duty banner + emergency (homepage)
  dutyBadge: 'Di turno',
  dutyBannerTitle: 'Sei di turno come {{role}}',
  dutyEmergencyButton: 'Emergenza: contatta i responsabili',
  dutyEmergencySent: 'Responsabili mostrati — il club è stato avvisato.',
  dutyEmergencyError: 'Impossibile inviare l\'avviso. Chiama direttamente un responsabile.',
  dutyEmergencyRevealed: 'Responsabili della squadra — contattali ora:',
  dutyEmergencyNoLeaders: 'Nessun responsabile registrato. Contatta Luca o Thamy.',
  roleCoach: 'Allenatore',
  roleResponsible: 'Responsabile squadra',
} as const
