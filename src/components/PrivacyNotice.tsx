import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

const STORAGE_KEY = 'kscw-privacy-noticed'

export default function PrivacyNotice() {
  const { t } = useTranslation('legal')
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setVisible(true)
    }
  }, [])

  if (!visible) return null

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1')
    setVisible(false)
  }

  return (
    <div className="fixed bottom-16 left-0 right-0 z-50 flex items-center justify-center px-4 sm:bottom-4">
      <div className="flex max-w-lg items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-800">
        <p className="text-gray-600 dark:text-gray-300">
          {t('noticeCookies')}{' '}
          <Link to="/datenschutz" className="underline hover:text-gray-900 dark:hover:text-white">
            {t('noticeLink')}
          </Link>
        </p>
        <button
          onClick={dismiss}
          className="shrink-0 rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
        >
          OK
        </button>
      </div>
    </div>
  )
}
