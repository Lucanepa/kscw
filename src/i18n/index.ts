import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import common from './locales/en/common'
import nav from './locales/en/nav'
import calendar from './locales/en/calendar'
import games from './locales/en/games'
import trainings from './locales/en/trainings'
import absences from './locales/en/absences'
import scorer from './locales/en/scorer'
import teams from './locales/en/teams'
import hallenplan from './locales/en/hallenplan'
import spielplanung from './locales/en/spielplanung'
import auth from './locales/en/auth'
import events from './locales/en/events'

import deCommon from './locales/de/common'
import deNav from './locales/de/nav'
import deCalendar from './locales/de/calendar'
import deGames from './locales/de/games'
import deTrainings from './locales/de/trainings'
import deAbsences from './locales/de/absences'
import deScorer from './locales/de/scorer'
import deTeams from './locales/de/teams'
import deHallenplan from './locales/de/hallenplan'
import deSpielplanung from './locales/de/spielplanung'
import deAuth from './locales/de/auth'
import deEvents from './locales/de/events'

const savedLng = typeof window !== 'undefined'
  ? localStorage.getItem('kscw-lang') ?? 'de'
  : 'de'

i18n.use(initReactI18next).init({
  lng: savedLng,
  fallbackLng: 'en',
  ns: [
    'common',
    'nav',
    'calendar',
    'games',
    'trainings',
    'absences',
    'scorer',
    'teams',
    'hallenplan',
    'spielplanung',
    'auth',
    'events',
  ],
  defaultNS: 'common',
  resources: {
    en: {
      common,
      nav,
      calendar,
      games,
      trainings,
      absences,
      scorer,
      teams,
      hallenplan,
      spielplanung,
      auth,
      events,
    },
    de: {
      common: deCommon,
      nav: deNav,
      calendar: deCalendar,
      games: deGames,
      trainings: deTrainings,
      absences: deAbsences,
      scorer: deScorer,
      teams: deTeams,
      hallenplan: deHallenplan,
      spielplanung: deSpielplanung,
      auth: deAuth,
      events: deEvents,
    },
  },
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
