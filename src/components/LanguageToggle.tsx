import { useTranslation } from 'react-i18next'

interface LanguageToggleProps {
  variant?: 'sidebar' | 'sheet'
  theme?: 'light' | 'dark'
}

export default function LanguageToggle({ variant = 'sidebar', theme = 'dark' }: LanguageToggleProps) {
  const { i18n } = useTranslation()
  const isDE = i18n.language === 'de'

  function toggle() {
    const next = isDE ? 'en' : 'de'
    i18n.changeLanguage(next)
    localStorage.setItem('kscw-lang', next)
  }

  if (variant === 'sheet') {
    return (
      <button
        onClick={toggle}
        className="flex min-h-[48px] w-full items-center gap-4 rounded-lg px-4 py-3 text-base font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
      >
        <span className="text-base">{isDE ? '🇬🇧' : '🇨🇭'}</span>
        {isDE ? 'English' : 'Deutsch'}
      </button>
    )
  }

  return (
    <button
      onClick={toggle}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
        theme === 'light'
          ? 'text-gray-600 hover:bg-gray-100'
          : 'text-gray-400 hover:bg-brand-800 hover:text-white'
      }`}
    >
      <span className="text-base">{isDE ? '🇬🇧' : '🇨🇭'}</span>
      {isDE ? 'English' : 'Deutsch'}
    </button>
  )
}
