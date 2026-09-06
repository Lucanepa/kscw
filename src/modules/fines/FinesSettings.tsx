import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { useFineRules, formatFineAmount } from '../../hooks/useFines'
import { createRecord, updateRecord, deleteRecord } from '../../lib/api'
import { Button } from '@/components/ui/button'
import { useConfirm } from '../../components/ConfirmProvider'
import type { FineCategory, FineResetWindow, FineRule, FineRuleTier } from '../../types'

const CATEGORIES: FineCategory[] = ['late_signin', 'no_show', 'late_payment', 'custom']
const WINDOWS: FineResetWindow[] = ['calendar_month', 'rolling_30d', 'rolling_90d', 'season', 'never']

function categoryLabelKey(c: string): string {
  return `category${c.charAt(0).toUpperCase()}${c.slice(1).replace(/_(.)/g, (_, ch) => ch.toUpperCase())}`
}

function windowLabelKey(w: FineResetWindow): string {
  switch (w) {
    case 'calendar_month': return 'windowMonth'
    case 'rolling_30d': return 'window30d'
    case 'rolling_90d': return 'window90d'
    case 'season': return 'windowSeason'
    case 'never': return 'windowNever'
  }
}

interface FinesSettingsProps {
  teamId: string | number
}

/**
 * Per-team Fines settings panel. Wraps itself in the existing accordion-style
 * shell (caller doesn't need to provide a SettingsGroup). Renders one
 * sub-section per category with its tier editor.
 */
export default function FinesSettings({ teamId }: FinesSettingsProps) {
  const { t } = useTranslation(['fines'])
  const [open, setOpen] = useState(false)
  const { data: rulesRaw, refetch } = useFineRules(teamId, { enabled: open })
  const rules = rulesRaw ?? []

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-gray-900 dark:text-gray-100"
        style={{ minHeight: 44 }}
      >
        <span>{t('fines:settingsTitle')}</span>
        <span className="text-gray-400 dark:text-gray-500">{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <div className="divide-y divide-gray-100 border-t border-gray-200 dark:divide-gray-700 dark:border-gray-700">
          <p className="px-4 py-3 text-xs italic text-gray-500 dark:text-gray-400">
            {t('fines:settingsDescription')}
          </p>
          {CATEGORIES.map((cat) => (
            <CategoryEditor
              key={cat}
              teamId={teamId}
              category={cat}
              rule={rules.find((r) => r.category === cat) ?? null}
              onChange={refetch}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Per-category editor ────────────────────────────────────────────

interface CategoryEditorProps {
  teamId: string | number
  category: FineCategory
  rule: FineRule | null
  onChange: () => void
}

function CategoryEditor({ teamId, category, rule, onChange }: CategoryEditorProps) {
  const { t } = useTranslation(['fines', 'common'])
  const confirm = useConfirm()
  const [enabled, setEnabled] = useState(rule?.enabled ?? false)
  const [resetWindow, setResetWindow] = useState<FineResetWindow>(rule?.reset_window ?? 'calendar_month')
  const [tiers, setTiers] = useState<FineRuleTier[]>(rule?.tiers ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  // Re-sync local state when the parent re-fetches. Adjust-state-during-render
  // keyed on exactly the same four values the old effect used as deps.
  const ruleId = rule?.id
  const ruleEnabled = rule?.enabled
  const ruleResetWindow = rule?.reset_window
  const ruleTiers = rule?.tiers
  const [prevRule, setPrevRule] = useState({ ruleId, ruleEnabled, ruleResetWindow, ruleTiers })
  if (
    prevRule.ruleId !== ruleId ||
    prevRule.ruleEnabled !== ruleEnabled ||
    prevRule.ruleResetWindow !== ruleResetWindow ||
    prevRule.ruleTiers !== ruleTiers
  ) {
    setPrevRule({ ruleId, ruleEnabled, ruleResetWindow, ruleTiers })
    setEnabled(ruleEnabled ?? false)
    setResetWindow(ruleResetWindow ?? 'calendar_month')
    setTiers(ruleTiers ?? [])
  }

  async function save(next: Partial<FineRule>) {
    setSaving(true)
    setError(null)
    try {
      if (rule) {
        await updateRecord<FineRule>('fine_rules', rule.id, next)
      } else {
        await createRecord<FineRule>('fine_rules', {
          team: Number(teamId),
          category,
          enabled: true,
          reset_window: 'calendar_month',
          tiers: [],
          ...next,
        })
      }
      setSavedAt(Date.now())
      onChange()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(t('fines:settingsSaveError', { error: msg }))
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleEnabled() {
    const next = !enabled
    setEnabled(next)
    await save({ enabled: next })
  }

  async function handleWindowChange(w: FineResetWindow) {
    setResetWindow(w)
    await save({ reset_window: w })
  }

  async function handleTiersChange(nextTiers: FineRuleTier[]) {
    setTiers(nextTiers)
    await save({ tiers: nextTiers })
  }

  async function handleDelete() {
    if (!rule) return
    if (!(await confirm({ message: t('common:confirmDelete') as string, danger: true }))) return
    await deleteRecord('fine_rules', rule.id)
    onChange()
  }

  function addTier() {
    const nextOffense = (tiers.length > 0 ? Math.max(...tiers.map((tt) => tt.offense ?? tt.offense_min ?? 0)) : 0) + 1
    handleTiersChange([...tiers, { offense: nextOffense, amount: 0 }])
  }

  function removeTier(idx: number) {
    handleTiersChange(tiers.filter((_, i) => i !== idx))
  }

  // Update tier fields locally only; persist on blur (below) so typing a digit
  // into an offense/amount field no longer fires a full fine_rules PATCH per
  // keystroke. Structural changes (add/remove/toggle) still save immediately.
  function updateTier(idx: number, patch: Partial<FineRuleTier>) {
    setTiers((prev) => prev.map((tt, i) => (i === idx ? { ...tt, ...patch } : tt)))
  }

  function toggleTierIsMin(idx: number) {
    handleTiersChange(tiers.map((tt, i) => {
      if (i !== idx) return tt
      if (tt.offense_min != null) return { offense: tt.offense_min, amount: tt.amount }
      return { offense_min: tt.offense ?? idx + 1, amount: tt.amount }
    }))
  }

  // Preview line
  const previewLine = tiers.length === 0
    ? t('fines:settingsNoTiers')
    : tiers.map((tt) => {
        const label = tt.offense_min != null ? `${tt.offense_min}+` : String(tt.offense ?? '?')
        return `${label}: ${formatFineAmount(tt.amount)}`
      }).join(' · ') + ` · ${t(`fines:${windowLabelKey(resetWindow)}`).toLowerCase()}`

  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t(`fines:${categoryLabelKey(category)}`)}
        </div>
        <label className="inline-flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            checked={enabled}
            onChange={handleToggleEnabled}
            className="h-4 w-4"
          />
          {t('fines:settingsEnabled')}
        </label>
      </div>

      {/* late_signin is the one category that acts on its own: enabling it arms
          the nightly sweep that declines and fines everyone who never answered.
          A coach ticking a box called "Enabled" deserves to be told that here,
          not to discover it from a member asking why they owe CHF 20. */}
      {category === 'late_signin' && enabled && (
        <p className="text-xs italic text-gray-500 dark:text-gray-400">
          {t('fines:settingsLateSigninSweep')}
        </p>
      )}

      {(enabled || rule) && (
        <>
          {/* Reset window */}
          <label className="block text-xs text-gray-600 dark:text-gray-400">
            {t('fines:settingsResetWindow')}
            <select
              value={resetWindow}
              onChange={(e) => handleWindowChange(e.target.value as FineResetWindow)}
              className="ml-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
            >
              {WINDOWS.map((w) => (
                <option key={w} value={w}>{t(`fines:${windowLabelKey(w)}`)}</option>
              ))}
            </select>
          </label>

          {/* Tiers */}
          <div className="space-y-2">
            <div className="text-xs font-medium text-gray-700 dark:text-gray-300">{t('fines:settingsTiers')}</div>
            {tiers.length === 0 && (
              <div className="text-xs italic text-gray-500 dark:text-gray-400">{t('fines:settingsNoTiers')}</div>
            )}
            {tiers.map((tier, idx) => {
              const isMin = tier.offense_min != null
              return (
                <div key={idx} className="flex flex-wrap items-center gap-2 rounded-md bg-gray-50 px-2 py-1.5 dark:bg-gray-800/40">
                  <label className="text-xs text-gray-600 dark:text-gray-400">
                    {isMin ? t('fines:settingsTierOffenseMin') : t('fines:settingsTierOffense')}
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={isMin ? (tier.offense_min ?? '') : (tier.offense ?? '')}
                    onChange={(e) => updateTier(idx, isMin
                      ? { offense_min: parseInt(e.target.value, 10) || 1 }
                      : { offense: parseInt(e.target.value, 10) || 1 })}
                    onBlur={() => save({ tiers })}
                    className="w-16 rounded-md border border-gray-300 bg-white px-1.5 py-1 text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  />
                  <span className="text-xs text-gray-400">·</span>
                  <input
                    type="number"
                    min="0"
                    step="0.05"
                    value={tier.amount}
                    onChange={(e) => updateTier(idx, { amount: parseFloat(e.target.value) || 0 })}
                    onBlur={() => save({ tiers })}
                    className="w-20 rounded-md border border-gray-300 bg-white px-1.5 py-1 text-right text-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                  />
                  <span className="text-xs text-gray-500">{t('fines:settingsTierAmount')}</span>
                  <label className="ml-auto inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                    <input type="checkbox" checked={isMin} onChange={() => toggleTierIsMin(idx)} className="h-3 w-3" />
                    {t('fines:settingsLastIsMin')}
                  </label>
                  <button
                    type="button"
                    onClick={() => removeTier(idx)}
                    className="text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                    aria-label={t('fines:settingsRemoveTier')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )
            })}
            <Button type="button" variant="outline" size="sm" onClick={addTier}>
              <Plus className="mr-1 h-4 w-4" />
              {t('fines:settingsAddTier')}
            </Button>
          </div>

          {/* Preview */}
          <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
            <span className="font-medium">{t('fines:settingsPreview')}: </span>
            {previewLine}
          </div>

          {rule && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {saving ? t('common:loading') : savedAt ? t('fines:settingsSaved') : ''}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={handleDelete}>
                {t('common:delete')}
              </Button>
            </div>
          )}

          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        </>
      )}
    </div>
  )
}
