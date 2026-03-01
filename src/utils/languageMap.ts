export function pbLangToI18n(pbLang: string): 'de' | 'en' {
  return pbLang === 'english' ? 'en' : 'de'
}

export function i18nToPbLang(i18nLang: string): 'english' | 'german' {
  return i18nLang === 'en' ? 'english' : 'german'
}
