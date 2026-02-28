import { useTranslation } from 'react-i18next'

export default function ImpressumPage() {
  const { t } = useTranslation('legal')

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-8 text-2xl font-bold text-gray-900 dark:text-white">
        {t('impressumTitle')}
      </h1>

      <Section>
        <p className="text-lg font-semibold text-gray-900 dark:text-white">
          {t('impressumClubName')}
        </p>
        <Whitespace text={t('impressumAddress')} />
        <p className="mt-2">{t('impressumContact')}</p>
        <p className="mt-2">{t('impressumBoard')}</p>
      </Section>

      <Section>
        <p>{t('impressumHosting')}</p>
      </Section>

      <Section title={t('impressumSocial')}>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <a
              href="https://www.facebook.com/KSC-Wiedikon-103576793063334"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-600 hover:underline dark:text-brand-400"
            >
              {t('impressumFacebook')}
            </a>
          </li>
          <li>
            <a
              href="https://www.instagram.com/ksc_wiedikon"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-600 hover:underline dark:text-brand-400"
            >
              {t('impressumInstagram')}
            </a>
          </li>
        </ul>
      </Section>

      <Section title={t('impressumDisclaimer')}>
        <p>{t('impressumDisclaimerText')}</p>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      {title && (
        <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
          {title}
        </h2>
      )}
      <div className="text-sm leading-relaxed text-gray-600 dark:text-gray-300">
        {children}
      </div>
    </section>
  )
}

function Whitespace({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => (
        <span key={i}>
          {line}
          {i < text.split('\n').length - 1 && <br />}
        </span>
      ))}
    </>
  )
}
