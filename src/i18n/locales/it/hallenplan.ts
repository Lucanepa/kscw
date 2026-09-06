export default {
  title: 'Piano palestra',
  subtitleDay: 'Vista giornaliera dell\'occupazione palestra',
  subtitleWeek: 'Vista settimanale dell\'occupazione palestra',

  // Slot form
  hall: 'Palestra',
  team: 'Squadra',
  searchTeam: 'Cerca squadra…',
  noTeamFound: 'Nessuna squadra trovata.',
  freeSlot: 'Slot di allenamento libero',
  freeSlotHint: 'Nessuna squadra assegnata — disponibile per qualsiasi squadra',
  dayOfWeek: 'Giorno della settimana',
  slotType: 'Tipo',
  startTime: 'Ora di inizio',
  endTime: 'Ora di fine',
  recurring: 'Ricorrente',
  validFrom: 'Valido da',
  validTo: 'Valido fino a',
  indefinitely: 'A tempo indeterminato',
  label: 'Etichetta',
  autoLabel: 'Etichetta automatica',
  notes: 'Note',

  // Slot types
  typeTraining: 'Allenamento',
  typeGame: 'Partita',
  typeEvent: 'Evento',
  typeOther: 'Altro',

  // Day names (full)
  dayMonday: 'Lunedì',
  dayTuesday: 'Martedì',
  dayWednesday: 'Mercoledì',
  dayThursday: 'Giovedì',
  dayFriday: 'Venerdì',
  daySaturday: 'Sabato',
  daySunday: 'Domenica',

  // Slot editor
  editSlot: 'Modifica fascia',
  editSlotTitle: 'Modifica fascia',
  newSlotTitle: 'Nuova fascia',
  deleteSlotConfirm: 'Sei sicuro di voler eliminare questa fascia?',
  selectPlaceholder: '-- Seleziona --',

  // Validation
  hallRequired: 'Seleziona una palestra',
  dayRequired: 'Seleziona un giorno',
  startTimeRequired: 'L\'ora di inizio è obbligatoria',
  endTimeRequired: 'L\'ora di fine è obbligatoria',

  // Closure manager
  closuresTitle: 'Gestisci chiusure palestra',
  currentClosures: 'Chiusure attuali',
  addNewClosure: 'Aggiungi nuova chiusura',
  editClosure: 'Modifica chiusura',
  noClosures: 'Nessuna chiusura attiva',
  deleteClosureConfirm: 'Sei sicuro di voler eliminare questa chiusura della palestra?',
  closuresSubtitle: 'Giorni in cui una palestra e chiusa. Una chiusura nasconde la palestra nel piano palestre, appare nel calendario e nel feed iCal, blocca le partite in casa e annulla gli allenamenti in quei giorni.',
  closuresScopeUpcoming: 'In arrivo',
  closuresScopeAll: 'Tutte',
  closuresColDates: 'Date',
  closureAddedToast_one: 'Chiusura aggiunta: {{range}}, 1 palestra',
  closureAddedToast_other: 'Chiusura aggiunta: {{range}}, {{count}} palestre',
  closureUpdatedToast_one: 'Chiusura aggiornata: {{range}}, 1 palestra',
  closureUpdatedToast_other: 'Chiusura aggiornata: {{range}}, {{count}} palestre',
  closureDeletedToast: 'Chiusura eliminata',
  closureSyncOwnedWarning: 'Questa origine e gestita da una sincronizzazione automatica — una chiusura salvata qui viene eliminata alla prossima esecuzione. Usa "Admin" o "Custode" per una chiusura manuale.',

  // Hall-administration calendar (gcal) — per-entry closure override
  gcalEntriesTitle: 'Calendario della gestione palestre',
  gcalEntriesSubtitle: 'Ogni voce che la gestione palestre inserisce in questo calendario chiude le palestre KWI. Se una voce non è una vera chiusura — per esempio una partita o un allenamento del club inserito da loro —, disattivala qui; gli allenamenti annullati tornano attivi.',
  gcalEntriesEmpty: 'Nessuna voce imminente dalla gestione palestre',
  gcalColEntry: 'Voce',
  gcalColEffect: 'Effetto',
  gcalEffectCloses: 'Chiude le palestre',
  gcalEffectOpen: 'Nessuna chiusura',
  gcalEffectConfirmed: 'Chiude le palestre (confermato)',
  gcalActionOpen: 'Nessuna chiusura',
  gcalActionClose: 'Chiudi le palestre',
  gcalCloseConfirm: 'Chiudere le palestre KWI per questa voce? Gli allenamenti di quei giorni verranno annullati.',
  gcalOverrideOffToast: 'Non è più una chiusura',
  gcalOverrideOnToast: 'Palestre chiuse',
  gcalTrainingsCancelledToast_one: '1 allenamento annullato',
  gcalTrainingsCancelledToast_other: '{{count}} allenamenti annullati',
  gcalTrainingsRestoredToast_one: '1 allenamento è di nuovo attivo',
  gcalTrainingsRestoredToast_other: '{{count}} allenamenti sono di nuovo attivi',

  // Publishing a club closure to the hall administration's calendar
  gcalPushCol: 'Calendario palestre',
  gcalPushNo: 'Non pubblicato',
  gcalPushYes: 'Pubblicato',
  gcalPushDuplicate: 'Già presente',
  gcalPushNotEligible: '—',
  gcalPushAction: 'Pubblica',
  gcalPushRemoveAction: 'Rimuovi',
  gcalPushConfirm: 'Pubblicare questa chiusura nel calendario della gestione palestre? La vedranno come una prenotazione del KSCW.',
  gcalPushRemoveConfirm: 'Rimuovere questa chiusura dal calendario della gestione palestre?',
  gcalPushedToast: 'Pubblicato nel calendario palestre',
  gcalPushRemovedToast: 'Rimosso dal calendario palestre',
  gcalPushDuplicateToast: 'Non pubblicato — la gestione palestre copre già questo periodo ({{title}})',
  gcalPushDryRunToast: 'Contrassegnato per la pubblicazione (dev gira a vuoto — nulla è stato scritto)',
  gcalPushDisabledToast: 'Contrassegnato, ma la pubblicazione sul calendario non è configurata in questo ambiente',



  // Closure sources
  source: 'Fonte',
  sourceCaretaker: 'Custode',
  sourceAdmin: 'Admin',
  sourceAutomatic: 'Automatico',
  sourceGcal: 'Google Calendar',
  sourceSchoolHolidays: 'Vacanze scolastiche',
  closed: 'Chiuso',
  allHalls: 'Tutte le palestre',
  halls: 'palestre',
  editAppliesToAllHalls: 'La modifica si applica a {{count}} palestre',
  hallsField: 'Palestre',
  selectHallsHint: 'Seleziona una o più palestre',
  presetKwi: 'KWI',

  // Navigation
  today: 'Oggi',
  closures: 'Chiusure',
  prevWeek: 'Settimana precedente',
  nextWeek: 'Settimana successiva',

  // Summary
  summary: 'Riepilogo',

  // Virtual slots
  typeAway: 'Trasferta',
  autoGenerated: 'Generato automaticamente',
  cancelled: 'Annullato',

  // Virtual slot detail labels
  league: 'Lega',
  start: 'Inizio',
  slot: 'Fascia',
  result: 'Risultato',
  location: 'Luogo',
  allDay: 'Tutto il giorno',
  date: 'Data',
  reason: 'Motivo',

  // Game statuses
  statusScheduled: 'Programmata',
  statusLive: 'In diretta',
  statusCompleted: 'Completata',
  statusPostponed: 'Rinviata',

  // Claim system
  slotFreed: 'Disponibile',
  slotClaimed: 'Richiesta',
  claimSlotTitle: 'Richiedi fascia palestra',
  claimConfirm: 'Richiedi',
  claimRelease: 'Rilascia',
  claimReleaseConfirm: 'Sei sicuro di voler rilasciare questa richiesta?',
  claimAlreadyTaken: 'Questa fascia è già stata richiesta.',
  claimPastDate: 'Non è possibile richiedere fasce passate.',
  claimTeamLabel: 'Per la squadra',
  claimReasonCancelled: 'Allenamento annullato',
  claimReasonAway: 'Partita in trasferta',
  claimReasonSpielhalle: 'Palestra di gara',
  claimOriginalTeam: 'Originariamente',
  claimClaimedBy: 'Richiesta da',
  claimClaimedAt: 'Richiesta il',
  claimNotes: 'Note',
  claimSuccess: 'Fascia richiesta con successo!',
  claimReleased: 'Richiesta rilasciata.',
  claimDetailTitle: 'Dettagli richiesta',

  // Filter
  vbOnly: 'Solo pallavolo',
  all: 'Tutti',

  // Admin navigation
  updateFutureTrainings: 'Aggiorna allenamenti futuri',
  goToTrainings: 'Vai agli allenamenti',
  goToGames: 'Vai alle partite',

  // Available slots
  slotsAvailable: '{{count}} fascia/e disponibile/i',
  slotsAvailableTitle: 'Fasce disponibili',
  slotsAvailableNone: 'Nessuna fascia disponibile',

  // Abbreviazioni dei giorni (intestazioni griglia / riepilogo)
  dayMonShort: 'Lun',
  dayTueShort: 'Mar',
  dayWedShort: 'Mer',
  dayThuShort: 'Gio',
  dayFriShort: 'Ven',
  daySatShort: 'Sab',
  daySunShort: 'Dom',

  // Rifiniture griglia / editor
  noDataToDisplay: 'Nessun dato da mostrare',
  switchOverlap: 'Alterna sovrapposizione',
  labelPlaceholder: 'es. Allenamento di prova, Partita in casa vs. TVA',
  sportVolleyball: 'Pallavolo',
  sportBasketball: 'Pallacanestro',
  claimNotesPlaceholder: 'Facoltativo…',
  closureReasonPlaceholder: 'es. Vacanze, manutenzione, ristrutturazione',

  // Registro palestre (/admin/hallenplan/halls)
  hallsNav: 'Palestre',
  hallsTitle: 'Gestisci palestre',
  hallsSubtitle: 'I luoghi a cui puntano ogni fascia oraria, allenamento e partita in casa. Una palestra deve esistere qui prima che una squadra possa ricevervi una fascia.',
  addNewHall: 'Aggiungi palestra',
  editHall: 'Modifica palestra',
  hallName: 'Nome',
  hallNameHint: 'Scegli un luogo noto per riprendere l\'indirizzo, oppure digita semplicemente un nome.',
  hallNamePlaceholder: 'es. KWI A',
  hallAddress: 'Indirizzo',
  hallCity: 'Località',
  hallCourts: 'Campi',
  hallMapsUrl: 'Link mappa',
  hallHomologation: 'Omologata',
  hallHomologationHint: 'Approvata per le partite di campionato',
  hallNameRequired: 'Inserisci il nome della palestra',
  hallSaved: 'Palestra salvata',
  hallDeleted: 'Palestra eliminata',
  hallDeleteConfirm: 'Eliminare "{{name}}"? Fasce, allenamenti e partite in questa palestra vanno prima spostati.',
  hallInUse: 'Questa palestra ha ancora delle fasce orarie. Rimuovile prima.',
  hallsEmpty: 'Nessuna palestra',
} as const
