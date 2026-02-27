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

i18n.use(initReactI18next).init({
  lng: 'en',
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
    },
  },
  interpolation: {
    escapeValue: false,
  },
})

export default i18n
