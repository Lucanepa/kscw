import type { Game, Training, Event, HallClosure } from './index'

/** Unified calendar entry for rendering and iCal export */
export interface CalendarEntry {
  id: string
  type: 'game' | 'training' | 'event' | 'closure'
  title: string
  date: Date
  startTime: string | null
  endTime: string | null
  allDay: boolean
  location: string
  teamNames: string[]
  description: string
  source: Game | Training | Event | HallClosure
}

export type ViewMode = 'calendar' | 'list-date' | 'list-team'
export type CalendarViewMode = 'month' | 'list'

export type SportFilter = 'volleyball' | 'basketball' | 'all'
export type GameTypeFilter = 'home' | 'away' | 'all'
export type SourceFilter = 'game' | 'training' | 'event' | 'closure'

export interface SpielplanungFilterState {
  sport: SportFilter
  selectedTeamIds: string[]
  gameType: GameTypeFilter
  showAbsences: boolean
}

export interface CalendarFilterState {
  sources: SourceFilter[]
  selectedTeamIds: string[]
}
