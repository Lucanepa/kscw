import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bug, Lightbulb, MessageCircle, Paperclip, X, ExternalLink, ChevronDown, ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useCollection } from '../../lib/query'
import { formatRelativeTime, formatDateZurich } from '../../utils/dateHelpers'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Textarea } from '../../components/ui/textarea'
import { Badge } from '../../components/ui/badge'
import { createRecord, API_URL, client } from '../../lib/api'
import { sanitizeUrl } from '../../utils/sanitizeUrl'

type FeedbackType = 'bug' | 'feature' | 'feedback'

const MAX_FILE_SIZE = 5 * 1024 * 1024
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

const TYPE_CONFIG = {
  bug: { icon: Bug, color: 'bg-red-500 text-white', badgeVariant: 'destructive' as const },
  feature: { icon: Lightbulb, color: 'bg-brand-600 text-white', badgeVariant: 'default' as const },
  feedback: { icon: MessageCircle, color: 'bg-green-600 text-white', badgeVariant: 'secondary' as const },
}

const STATUS_COLORS: Record<string, string> = {
  new: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  github: 'bg-brand-100 text-brand-800 dark:bg-brand-900/30 dark:text-brand-300',
  closed: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
}

interface FeedbackRecord {
  id: string
  type: FeedbackType
  title: string
  description: string
  source: string
  source_url: string
  screenshot: string | null
  screenshots?: string[] | null
  status: string
  github_issue: string
  user: string
  date_created: string
  date_updated: string
}

interface GitHubLabel {
  name: string
  color: string
}

interface GitHubComment {
  id: string
  body: string
  author: { login: string }
  createdAt: string
}

interface GitHubIssue {
  number: number
  title: string
  state: string
  body: string
  labels: GitHubLabel[]
  comments: GitHubComment[]
  createdAt: string
  closedAt: string | null
  url: string
}

const GITHUB_REPO = 'Lucanepa/wiedisync'

export default function FeedbackPage() {
  const { t, i18n } = useTranslation('feedback')
  const { user } = useAuth()
  const [showForm, setShowForm] = useState(false)
  const [selectedType, setSelectedType] = useState<FeedbackType>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)

  const {
    data: submissionsRaw,
    isLoading: submissionsLoading,
    isError: submissionsError,
    isPlaceholderData: submissionsStale,
    refetch,
  } = useCollection<FeedbackRecord>('feedback', {
    filter: user ? { user: { _eq: user.id } } : undefined,
    sort: ['-date_created'],
    all: true,
    enabled: !!user,
  })
  const submissions = submissionsRaw ?? []
  // "Still loading" must not look like "you have never submitted anything".
  // `isError` is the escape hatch: TanStack clears isLoading on a failed fetch while
  // `data` stays undefined, so gating on undefined alone would strand the section in a
  // permanent skeleton. `isPlaceholderData` covers the global keepPreviousData default —
  // after an acting-member swap the key changes and the previous member's rows would
  // otherwise be shown as yours.
  const submissionsPending =
    !!user && !submissionsError && (submissionsLoading || submissionsStale || submissionsRaw === undefined)

  // GitHub issues — cached via react-query so remounting the page doesn't refetch
  // within the stale window, and an error/rate-limit response surfaces an explicit
  // error state instead of silently showing "no issues".
  const [showClosed, setShowClosed] = useState(false)

  const {
    data: issues = [],
    isLoading: issuesLoading,
    isError: issuesError,
  } = useQuery<GitHubIssue[]>({
    queryKey: ['github-issues', GITHUB_REPO],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues?state=all&per_page=50&sort=created&direction=desc`)
      if (!r.ok) throw new Error(`GitHub API ${r.status}`)
      const data: unknown = await r.json()
      // A rate-limited / error response is an object ({ message, ... }), not an
      // array — guard so we throw (→ error state) rather than crash inside .filter.
      if (!Array.isArray(data)) throw new Error('Unexpected GitHub response')
      // GitHub API returns PRs in the issues endpoint — filter them out.
      return (data as Array<Record<string, unknown>>)
        .filter((d) => !d.pull_request)
        .map((d) => ({
          number: d.number as number,
          title: d.title as string,
          state: d.state as string,
          body: (d.body as string) ?? '',
          labels: ((d.labels as Array<Record<string, string>>) ?? []).map((l) => ({
            name: l.name,
            color: l.color,
          })),
          comments: [] as GitHubComment[],
          createdAt: d.created_at as string,
          closedAt: (d.closed_at as string) ?? null,
          url: d.html_url as string,
        }))
    },
  })

  const openIssues = useMemo(() => issues.filter((i) => i.state === 'open'), [issues])
  const closedIssues = useMemo(() => issues.filter((i) => i.state === 'closed'), [issues])

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const valid: File[] = []
    for (const f of Array.from(incoming)) {
      if (f.size > MAX_FILE_SIZE) { toast.error(t('validationFileSize')); continue }
      if (!ALLOWED_TYPES.includes(f.type)) { toast.error(t('validationFileType')); continue }
      valid.push(f)
    }
    setFiles((prev) => [...prev, ...valid].slice(0, 5))
  }, [t])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
  }, [addFiles])

  const resetForm = () => {
    setTitle('')
    setDescription('')
    setFiles([])
    setSelectedType('bug')
    setShowForm(false)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) { toast.error(t('validationTitle')); return }
    if (!description.trim()) { toast.error(t('validationDescription')); return }

    setSubmitting(true)
    try {
      // Upload ALL selected screenshots (up to 5), collecting their file ids.
      const screenshotIds: string[] = []
      if (files.length > 0) {
        const token = await client.getToken()
        for (const file of files) {
          const fd = new FormData()
          fd.append('file', file)
          const res = await fetch(`${API_URL}/files`, {
            method: 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            body: fd,
          })
          if (res.ok) {
            const result = await res.json()
            if (result.data?.id) screenshotIds.push(result.data.id)
          }
        }
      }

      const payload: Record<string, unknown> = {
        type: selectedType,
        title: title.trim(),
        description: description.trim(),
        source: 'wiedisync',
        status: 'new',
        source_url: window.location.origin,
      }
      if (user) payload.user = user.id
      if (screenshotIds.length > 0) {
        payload.screenshots = screenshotIds
        payload.screenshot = screenshotIds[0] // primary (back-compat + quarantine)
      }

      await createRecord('feedback', payload)

      const msg = selectedType === 'bug' ? t('successBug')
        : selectedType === 'feature' ? t('successFeature')
        : t('success')
      toast.success(msg)
      resetForm()
      refetch()
    } catch {
      toast.error(t('error'))
    } finally {
      setSubmitting(false)
    }
  }

  const formatDate = (dateStr: string) => {
    if (!dateStr) return ''
    if (isNaN(new Date(dateStr).getTime())) return ''
    return formatRelativeTime(dateStr, i18n.language)
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{t('title')}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('subtitle')}</p>
        </div>
        {!showForm && (
          <Button onClick={() => setShowForm(true)}>
            + {t('newFeedback')}
          </Button>
        )}
      </div>

      {/* New feedback form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="mb-8 rounded-xl border border-brand-200 bg-white p-5 shadow-sm dark:border-brand-800 dark:bg-gray-800">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{t('newFeedback')}</h2>

          {/* Type pills */}
          <div className="mb-4 flex gap-2">
            {(['bug', 'feature', 'feedback'] as const).map((type) => {
              const config = TYPE_CONFIG[type]
              const Icon = config.icon
              const isActive = selectedType === type
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setSelectedType(type)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive ? config.color : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {t(`type${type.charAt(0).toUpperCase() + type.slice(1)}`)}
                </button>
              )
            })}
          </div>

          {/* Title */}
          <div className="mb-3">
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('fieldTitle')} *
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('fieldTitlePlaceholder')}
              required
            />
          </div>

          {/* Description */}
          <div className="mb-3">
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('fieldDescription')} *
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('fieldDescriptionPlaceholder')}
              rows={4}
              required
            />
          </div>

          {/* Screenshots (up to 5) */}
          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('fieldScreenshot')} ({files.length}/5)
            </label>
            {files.length < 5 && (
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleDrop}
                onClick={() => document.getElementById('feedback-file')?.click()}
                className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 p-4 text-sm text-gray-500 transition-colors hover:border-brand-400 dark:border-gray-600 dark:text-gray-400 dark:hover:border-brand-500"
              >
                <Paperclip className="h-4 w-4" />
                {t('fieldScreenshotHint')}
                <input
                  id="feedback-file"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  className="hidden"
                  onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }}
                />
              </div>
            )}
            {files.length > 0 && (
              <div className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-1.5 text-sm dark:bg-gray-700">
                    <span className="flex-1 truncate">{f.name}</span>
                    <button type="button" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-500">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button type="submit" disabled={submitting}>
              {submitting ? t('submitting') : t('submit')}
            </Button>
            <Button type="button" variant="outline" onClick={resetForm}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* GitHub Issues — public tracker */}
      <div className="mb-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {t('issueTracker')}
        </h2>

        {issuesLoading ? (
          <div className="py-4 text-center text-sm text-gray-400">{t('loadingIssues')}</div>
        ) : issuesError ? (
          <p className="text-sm text-red-500 dark:text-red-400">{t('error')}</p>
        ) : issues.length === 0 ? (
          <p className="text-sm text-gray-400 dark:text-gray-500">{t('noIssues')}</p>
        ) : (
          <div className="space-y-4">
            {/* Open issues */}
            {openIssues.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {t('openIssues')} ({openIssues.length})
                  </span>
                </div>
                <div className="space-y-1.5">
                  {openIssues.map((issue) => (
                    <IssueRow key={issue.number} issue={issue} formatDate={formatDate} />
                  ))}
                </div>
              </div>
            )}

            {/* Closed issues — collapsible */}
            {closedIssues.length > 0 && (
              <div>
                <button
                  onClick={() => setShowClosed((v) => !v)}
                  className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                >
                  {showClosed ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  <CheckCircle2 className="h-4 w-4 text-purple-500 dark:text-purple-400" />
                  <span>{t('closedIssues')} ({closedIssues.length})</span>
                </button>
                {showClosed && (
                  <div className="space-y-1.5">
                    {closedIssues.map((issue) => (
                      <IssueRow key={issue.number} issue={issue} formatDate={formatDate} closed />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* My submissions */}
      {user && (
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t('mySubmissions')}
          </h2>
          {submissionsPending ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800"
                >
                  <div className="h-5 w-16 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="h-4 w-2/5 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="h-3 w-24 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                  </div>
                  <div className="h-5 w-14 animate-pulse rounded-full bg-gray-200 dark:bg-gray-700" />
                </div>
              ))}
            </div>
          ) : submissionsError ? (
            <p className="text-sm text-red-500 dark:text-red-400">{t('error')}</p>
          ) : submissions.length === 0 ? (
            <p className="text-sm text-gray-400 dark:text-gray-500">{t('noSubmissions')}</p>
          ) : (
            <div className="space-y-2">
              {submissions.map((item) => {
                const config = TYPE_CONFIG[item.type] || TYPE_CONFIG.feedback
                return (
                  <div key={item.id} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
                    <Badge variant={config.badgeVariant} className="text-xs uppercase">
                      {item.type}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-gray-900 dark:text-white">{item.title}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">{formatDate(item.date_created)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[item.status] || ''}`}>
                        {t(`status${item.status.charAt(0).toUpperCase() + item.status.slice(1)}`)}
                      </span>
                      {item.github_issue && sanitizeUrl(item.github_issue) && (
                        <a href={sanitizeUrl(item.github_issue)} target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-brand-600">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function IssueRow({ issue, formatDate, closed }: { issue: GitHubIssue; formatDate: (d: string) => string; closed?: boolean }) {
  const { t } = useTranslation('feedback')
  const [expanded, setExpanded] = useState(false)

  const labelColorMap: Record<string, string> = {
    d73a4a: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    '0075ca': 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    '008672': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
    a2eeef: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300',
    e4e669: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
    d876e3: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
    ededed: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  }

  return (
    <div className={`rounded-lg border bg-white dark:bg-gray-800 ${closed ? 'border-gray-100 dark:border-gray-700/50 opacity-70' : 'border-gray-200 dark:border-gray-700'}`}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        {closed
          ? <CheckCircle2 className="h-4 w-4 shrink-0 text-purple-500 dark:text-purple-400" />
          : <AlertCircle className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
        }
        <span className="text-xs font-medium text-gray-400 dark:text-gray-500">#{issue.number}</span>
        <span className={`min-w-0 flex-1 truncate text-sm font-medium ${closed ? 'text-gray-500 line-through dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`}>
          {issue.title}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {issue.labels.filter(l => l.name !== 'user-reported').map((label) => (
            <span
              key={label.name}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${labelColorMap[label.color] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'}`}
            >
              {label.name}
            </span>
          ))}
          <span className="text-xs text-gray-400 dark:text-gray-500">{formatDate(issue.createdAt)}</span>
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-700">
          {issue.body && (
            <p className="mb-3 whitespace-pre-wrap text-sm text-gray-600 dark:text-gray-400">{issue.body}</p>
          )}
          {closed && issue.closedAt && (
            <p className="mb-2 text-xs text-purple-600 dark:text-purple-400">
              {t('resolvedOn')} {formatDateZurich(issue.closedAt)}
            </p>
          )}
          <a
            href={sanitizeUrl(issue.url)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 dark:text-brand-400 dark:hover:text-brand-300"
          >
            <ExternalLink className="h-3 w-3" />
            {t('viewOnGithub')}
          </a>
        </div>
      )}
    </div>
  )
}
