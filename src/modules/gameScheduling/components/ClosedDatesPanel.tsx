import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Building2, CalendarX2, Settings2 } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { useCollection } from '../../../lib/query'
import type { HallClosure } from '../../../types'

const EMPTY: HallClosure[] = []

/**
 * Closed dates (hall closures) surfaced in the Spielplanung settings — auto
 * (school holidays, calendar sync) + manual. This panel is the summary; the full
 * view/add/edit/delete lives on the /admin/terminplanung/closures subpage (the same
 * page the member app mounts at /admin/hallenplan/closures).
 * Admin-gated by the caller. Closures block HOME slots whose hall is closed.
 */
export default function ClosedDatesPanel() {
  const { t } = useTranslation('gameScheduling')
  const navigate = useNavigate()
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])

  const { data: closuresRaw } = useCollection<HallClosure>('hall_closures', {
    filter: { end_date: { _gte: today } },
    sort: ['start_date'],
    fields: ['id', 'source'],
    limit: 1000,
  })
  const closures = closuresRaw ?? EMPTY

  // Auto = synced (school holidays + calendar); manual = everything a person set.
  const autoCount = closures.filter((c) => c.source === 'school_holidays' || c.source === 'gcal' || c.source === 'auto').length
  const manualCount = closures.length - autoCount

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 sm:p-6 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-1 flex items-center gap-2">
        <CalendarX2 className="h-5 w-5 text-gray-500 dark:text-gray-400" />
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('closedDatesTitle')}</h2>
      </div>
      <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">{t('closedDatesDescription')}</p>

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
          {t('closedDatesAuto', { count: autoCount })}
        </span>
        <span className="rounded-full bg-gray-100 px-2 py-1 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
          {t('closedDatesManual', { count: manualCount })}
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => navigate('/admin/terminplanung/closures')}
          className="gap-1.5"
        >
          <Settings2 className="h-4 w-4" />{t('closedDatesManage')}
        </Button>
        {/* The venue register the closures above (and every home slot) point at.
            A hall has to exist before it can be closed or slotted. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => navigate('/admin/terminplanung/halls')}
          className="gap-1.5"
        >
          <Building2 className="h-4 w-4" />{t('hallsManage')}
        </Button>
      </div>
    </div>
  )
}
