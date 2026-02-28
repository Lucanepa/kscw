import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../components/Modal'
import { useAuth } from '../../hooks/useAuth'
import { getFileUrl } from '../../utils/pbFile'
import pb from '../../pb'

interface ProfileEditModalProps {
  open: boolean
  onClose: () => void
}

export default function ProfileEditModal({ open, onClose }: ProfileEditModalProps) {
  const { user } = useAuth()
  const { t } = useTranslation('auth')
  const { t: tc } = useTranslation('common')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [number, setNumber] = useState<number>(0)
  const [photoFile, setPhotoFile] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resetSent, setResetSent] = useState(false)
  const [resetLoading, setResetLoading] = useState(false)

  useEffect(() => {
    if (user && open) {
      setFirstName(user.first_name ?? '')
      setLastName(user.last_name ?? '')
      setEmail(user.email ?? '')
      setPhone(user.phone ?? '')
      setNumber(user.number ?? 0)
      setPhotoFile(null)
      setPhotoPreview(null)
      setError('')
      setResetSent(false)
      setResetLoading(false)
    }
  }, [user, open])

  function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  async function handlePasswordReset() {
    if (!user?.email) return
    setResetLoading(true)
    try {
      await pb.collection('members').requestPasswordReset(user.email)
      setResetSent(true)
    } catch {
      setError(t('errorSaving'))
    } finally {
      setResetLoading(false)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!user) return
    setError('')
    setLoading(true)

    try {
      // Check for duplicate number in the same team(s)
      if (number > 0 && number !== user.number) {
        const myTeams = await pb.collection('member_teams').getFullList({
          filter: `member="${user.id}"`,
        })
        const teamIds = myTeams.map((mt) => mt.team)
        if (teamIds.length > 0) {
          const teamFilter = teamIds.map((id) => `team="${id}"`).join(' || ')
          const teammates = await pb.collection('member_teams').getFullList({
            filter: `(${teamFilter}) && member!="${user.id}"`,
            expand: 'member',
          })
          const conflict = teammates.find(
            (mt) => (mt.expand as { member?: { number?: number } })?.member?.number === number
          )
          if (conflict) {
            const conflictName = (conflict.expand as { member?: { name?: string } })?.member?.name ?? '?'
            setError(t('numberTaken', { name: conflictName }))
            setLoading(false)
            return
          }
        }
      }

      const formData = new FormData()
      formData.append('first_name', firstName)
      formData.append('last_name', lastName)
      formData.append('name', `${firstName} ${lastName}`.trim())
      formData.append('email', email)
      formData.append('phone', phone)
      formData.append('number', String(number))
      if (photoFile) {
        formData.append('photo', photoFile)
      }

      await pb.collection('members').update(user.id, formData)
      await pb.collection('members').authRefresh()
      onClose()
    } catch {
      setError(t('errorSaving'))
    } finally {
      setLoading(false)
    }
  }

  if (!user) return null

  const initials = `${firstName?.[0] ?? ''}${lastName?.[0] ?? ''}`.toUpperCase()
  const currentPhoto = photoPreview
    ?? (user.photo ? getFileUrl('members', user.id, user.photo) : null)

  return (
    <Modal open={open} onClose={onClose} title={t('editProfile')} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Photo */}
        <div className="flex items-center gap-4">
          {currentPhoto ? (
            <img
              src={currentPhoto}
              alt=""
              className="h-16 w-16 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-200 text-lg font-bold text-gray-500 dark:bg-gray-700 dark:text-gray-400">
              {initials}
            </div>
          )}
          <div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg border px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              {t('changePhoto')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handlePhotoChange}
              className="hidden"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('firstName')}</label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('lastName')}</label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('email')}</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('phone')}</label>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">{t('number')}</label>
          <input
            type="number"
            min={0}
            max={99}
            value={number || ''}
            onChange={(e) => setNumber(parseInt(e.target.value) || 0)}
            placeholder="#"
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500 focus:outline-none dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          />
        </div>

        {/* Change Password */}
        <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-600 dark:bg-gray-800/50">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('changePassword')}
          </span>
          {resetSent ? (
            <span className="text-sm text-green-600 dark:text-green-400">
              {t('resetLinkSent')}
            </span>
          ) : (
            <button
              type="button"
              onClick={handlePasswordReset}
              disabled={resetLoading}
              className="rounded-lg border border-brand-500 px-3 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-400 dark:text-brand-400 dark:hover:bg-brand-900/20"
            >
              {resetLoading ? tc('saving') : t('sendResetLink')}
            </button>
          )}
        </div>

        {/* Read-only fields */}
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3 dark:border-gray-600 dark:bg-gray-800/50">
          <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">
            {t('managedByCoach')}
          </p>
          <div className="flex flex-wrap gap-4 text-sm text-gray-600 dark:text-gray-400">
            {user.license_nr && <span>{t('licenseNr')}: {user.license_nr}</span>}
            <span className="capitalize">{t('position')}: {user.position}</span>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
          >
            {tc('cancel')}
          </button>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {loading ? tc('saving') : tc('save')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
