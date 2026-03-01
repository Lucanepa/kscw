import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  size?: 'sm' | 'md' | 'lg'
  hideClose?: boolean
}

const sizeClasses = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
}

export default function Modal({ open, onClose, title, children, size = 'md', hideClose }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    if (open) {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      onClose={hideClose ? (e) => e.preventDefault() : onClose}
      onCancel={hideClose ? (e) => e.preventDefault() : undefined}
      onClick={(e) => {
        if (e.target === ref.current && !hideClose) onClose()
      }}
      className={`fixed inset-x-0 bottom-0 top-auto m-0 w-full rounded-t-xl bg-white p-0 shadow-xl backdrop:bg-black/50 sm:inset-0 sm:m-auto sm:rounded-lg dark:bg-gray-800 ${sizeClasses[size]}`}
    >
      <div className="w-full">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 sm:px-6 sm:py-4 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          {!hideClose && (
            <button
              onClick={onClose}
              className="flex min-h-[44px] min-w-[44px] items-center justify-center text-gray-400 hover:text-gray-600 sm:min-h-0 sm:min-w-0 dark:hover:text-gray-300"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto p-4 sm:max-h-[calc(100vh-12rem)] sm:p-6">
          {children}
        </div>
      </div>
    </dialog>
  )
}
