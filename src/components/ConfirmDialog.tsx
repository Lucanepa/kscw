import { useTranslation } from 'react-i18next'
import Modal from './Modal'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}

export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  danger = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <p className="text-sm text-gray-600 dark:text-gray-400">{message}</p>
      <div className="mt-6 flex justify-end gap-3">
        <button
          onClick={onClose}
          className="min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 sm:min-h-0 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          {t('cancel')}
        </button>
        <button
          onClick={() => {
            onConfirm()
            onClose()
          }}
          className={`min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium text-white sm:min-h-0 ${
            danger ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-500 hover:bg-brand-600'
          }`}
        >
          {confirmLabel ?? t('confirm')}
        </button>
      </div>
    </Modal>
  )
}
