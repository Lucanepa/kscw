import { useTranslation } from 'react-i18next'

export default function DatenschutzPage() {
  const { t } = useTranslation('legal')

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-2 text-2xl font-bold text-gray-900 dark:text-white">
        {t('privacyTitle')}
      </h1>
      <p className="mb-8 text-sm text-gray-500 dark:text-gray-400">
        {t('lastUpdated')}
      </p>

      <Section title={t('controllerTitle')}>
        <Whitespace text={t('controllerText')} />
      </Section>

      <Section title={t('dataCollectedTitle')}>
        <h3 className="mb-1 font-semibold text-gray-800 dark:text-gray-200">
          {t('dataAccountTitle')}
        </h3>
        <p className="mb-4">{t('dataAccountText')}</p>

        <h3 className="mb-1 font-semibold text-gray-800 dark:text-gray-200">
          {t('dataRosterTitle')}
        </h3>
        <p className="mb-4">{t('dataRosterText')}</p>

        <h3 className="mb-1 font-semibold text-gray-800 dark:text-gray-200">
          {t('dataInternalTitle')}
        </h3>
        <p className="mb-4">{t('dataInternalText')}</p>

        <h3 className="mb-1 font-semibold text-gray-800 dark:text-gray-200">
          {t('dataTechnicalTitle')}
        </h3>
        <p>{t('dataTechnicalText')}</p>
      </Section>

      <Section title={t('legalBasisTitle')}>
        <p className="mb-3">{t('legalBasisText')}</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>{t('legalBasisContract')}</li>
          <li>{t('legalBasisInterest')}</li>
          <li>{t('legalBasisConsent')}</li>
        </ul>
      </Section>

      <Section title={t('thirdPartyTitle')}>
        <ul className="list-disc space-y-2 pl-5">
          <li>{t('thirdPartyCloudflare')}</li>
          <li>{t('thirdPartySwissVolley')}</li>
          <li>{t('thirdPartyGCal')}</li>
        </ul>
      </Section>

      <Section title={t('storageTitle')}>
        <p className="mb-3">{t('storageServer')}</p>
        <p className="mb-3">{t('storageLocal')}</p>
        <p>{t('storageNoCookies')}</p>
      </Section>

      <Section title={t('rightsTitle')}>
        <p className="mb-3">{t('rightsText')}</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>{t('rightsAccess')}</li>
          <li>{t('rightsCorrection')}</li>
          <li>{t('rightsDeletion')}</li>
          <li>{t('rightsPortability')}</li>
        </ul>
        <p className="mt-4">{t('rightsContact')}</p>
      </Section>

      <Section title={t('photosTitle')}>
        <p>{t('photosText')}</p>
      </Section>

      <Section title={t('changesTitle')}>
        <p>{t('changesText')}</p>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
        {title}
      </h2>
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
