export default {
  /** Migration 354: trainings_hall_slot_date_uq rejected a concurrent create. */
  duplicateSlotDate: 'Esiste già un allenamento per questo slot di palestra in questa data. Aggiorna e riprova — qualcuno potrebbe averlo appena creato.',
  title: 'Allenamenti',
  subtitle: 'Panoramica allenamenti con monitoraggio presenze',

  // Tabs
  tabTrainings: 'Allenamenti',
  tabCoachDashboard: 'Dashboard allenatore',

  // Training card
  attendance: 'Presenze',
  cancelled: 'Annullato',

  // Attendance sheet
  attendanceTitle: 'Presenze — {{date}}',
  attendanceTitleShort: 'Presenze',
  noPlayers: 'Nessun giocatore',
  noPlayersAssigned: 'Nessun giocatore è stato ancora assegnato a questa squadra.',

  // Coach dashboard
  seasonLabel: 'Stagione',
  rangeFromLabel: 'Da',
  rangeToLabel: 'A',
  resetRange: 'Reimposta predefiniti',
  rangeInvalid: '"Da" deve essere prima o uguale a "A"',
  noDataAvailable: 'Nessun dato disponibile',
  noDataDescription: 'Nessun dato di presenze da visualizzare.',

  // Table headers
  playerCol: 'Giocatore',
  numberCol: '#',
  trainingsCol: 'Allenamenti',
  presentCol: 'Presente',
  absentCol: 'Assente',
  rateCol: 'Tasso',
  trendCol: 'Tendenza',

  // Filter
  showPast: 'Mostra allenamenti precedenti',
  hidePast: 'Nascondi allenamenti precedenti',

  // Empty states
  noTrainings: 'Nessun allenamento',
  noTrainingsDescription: 'Nessun allenamento trovato per i filtri selezionati.',

  // CRUD
  newTraining: 'Nuovo allenamento',
  newSingleTraining: 'Allenamento singolo',
  newRecurringTraining: 'Allenamenti ricorrenti',
  editTraining: 'Modifica allenamento',
  deleteTraining: 'Elimina allenamento',
  deleteConfirm: 'Sei sicuro di voler eliminare questo allenamento?',
  cancelTraining: 'Annulla allenamento',
  trainingCancelled: 'Allenamento annullato',
  cancelReason: 'Motivo annullamento',

  // Recurring
  recurringTitle: 'Genera allenamenti ricorrenti',
  selectSlot: 'Seleziona fascia palestra',
  dateRange: 'Intervallo date',
  generatePreview: 'Anteprima date',
  generate: 'Genera',
  trainingsGenerated: '{{count}} allenamenti generati',
  trainingsSkipped: '{{count}} saltati (già esistenti)',
  respondBy: 'Rispondi entro',
  respondByHint: 'Promemoria 1 giorno prima',
  respondByTime: 'Ora limite di iscrizione',
  respondByHours: 'ore',
  respondByDays: 'giorni',
  respondByWeeks: 'settimane',
  respondByMonths: 'mesi',
  respondByBefore: 'prima',
  participation: 'Partecipazione',
  minParticipants: 'Min. partecipanti',
  maxParticipants: 'Max. partecipanti',
  untilSeasonEnd: 'A tempo indeterminato',
  slotFrom: 'da',
  slotUntil: 'fino a',

  // Recurring edit
  editRecurringTitle: 'Modifica allenamento ricorrente',
  editRecurringDescription: 'Questo allenamento fa parte di una serie ricorrente. Cosa vuoi modificare?',
  editThisOnly: 'Solo questo allenamento',
  editSameDay: 'Tutti gli allenamenti dello stesso giorno della settimana',
  editAllRecurring: 'Tutti gli allenamenti ricorrenti',
  cancelEdit: 'Annulla',

  // Slot mode
  slotDetected: 'Fascia palestra rilevata',
  claimedSlot: 'Fascia richiesta',
  regularSlot: 'Fascia regolare',
  noSlotForDay: 'Nessuna fascia palestra per questo giorno',
  useSlot: 'Usa fascia palestra',
  enterManually: 'Inserisci manualmente',
  slotModeAuto: 'Fascia auto',
  slotModeManual: 'Manuale',
  autoCancelOnMin: 'Cancellazione automatica',
  autoCancelOnMinHint: "L'allenamento verrà cancellato automaticamente alla scadenza se ci sono meno conferme del minimo",
  excludedGuestLevels: 'Ospiti esclusi',
  excludedGuestLevelsHint: 'Gli ospiti dei livelli selezionati non possono confermare o indicare incerto',
  excludeAllGuests: 'Tutti gli ospiti',
  guestExcluded: 'Il tuo livello di ospite è escluso da questo allenamento',
  autoConfirmRsvp: 'Conferma automatica',
  autoConfirmRsvpHint: 'Sovrascrivi il valore predefinito della squadra ({{default}}). Tutti i membri idonei partono come confermati; devono annullare manualmente.',
  useTeamDefault: 'Valore predefinito della squadra',
  on: 'On',
  off: 'Off',
  isTrialTraining: 'Allenamento di prova',
  isTrialTrainingHint: 'Visibile pubblicamente sulla pagina della squadra quando la squadra è aperta a nuovi giocatori.',
  trialBadge: 'Prova',
  shortenedBadge: 'Accorciato',
  shortenedHint: 'Termina prima — dopo si gioca una partita in casa in palestra',

  // Serie — manuale (senza fascia palestra)
  weekday: 'Giorno della settimana',
  manualStartTime: 'Ora di inizio',
  manualEndTime: 'Ora di fine',
  manualHint: 'Non viene usata nessuna fascia palestra. Scegli tu il giorno, gli orari e la palestra — la serie non è legata a una fascia, quindi un annullamento non libera tempo palestra per le altre squadre.',
  manualEndAfterStart: 'L\'ora di fine deve essere successiva a quella di inizio.',
  noSlotsForTeam: 'Questa squadra non ha fasce palestra. Passa all\'inserimento manuale per generare comunque una serie.',
} as const
