import { useRef, useEffect, useMemo } from 'react'
import { EditorView, keymap, placeholder as cmPlaceholder, tooltips } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { sql, PostgreSQL } from '@codemirror/lang-sql'
import { autocompletion, startCompletion, type CompletionSource } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import { useTheme } from '@/hooks/useTheme'
import { makeCompletionSource } from '../utils/sqlCompletion'
import type { SqlSchemaColumn, SqlSchemaTable } from '../utils/sqlSchema'

export type { SqlSchemaColumn, SqlSchemaTable }

interface CodeMirrorEditorProps {
  value: string
  onChange: (value: string) => void
  onExecute: () => void
  tables: readonly SqlSchemaTable[]
  placeholder?: string
}

function completionExtension(source: CompletionSource) {
  return autocompletion({
    activateOnTyping: true,
    defaultKeymap: true,
    maxRenderedOptions: 60,
    // The type glyphs render as an empty box under the one-dark theme and eat
    // a tab stop's worth of width on a phone; the detail line already says
    // what each option is.
    icons: false,
    // The info panel is what covers the list on a phone: it is rendered beside
    // the options on a wide screen and on top of them on a narrow one. Below
    // `md` it is hidden entirely (see the theme) and every fact it carried is
    // in the option's own detail line instead.
    closeOnBlur: true,
    override: [source],
  })
}

export default function CodeMirrorEditor({
  value,
  onChange,
  onExecute,
  tables,
  placeholder,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const externalValueRef = useRef(value)
  const onExecuteRef = useRef(onExecute)
  const onChangeRef = useRef(onChange)
  const themeCompartment = useRef(new Compartment())
  const completionCompartment = useRef(new Compartment())
  const { theme } = useTheme()

  // Latest-callback refs. Written after commit (never during render) — the only
  // readers are the CodeMirror keymap handler and the updateListener, both of
  // which fire from editor events, i.e. always after the commit that wrote them.
  useEffect(() => {
    onExecuteRef.current = onExecute
    onChangeRef.current = onChange
  })

  const completionSource = useMemo(() => makeCompletionSource(tables), [tables])

  useEffect(() => {
    if (!containerRef.current) return

    const executeKeymap = keymap.of([
      {
        key: 'Ctrl-Enter',
        mac: 'Cmd-Enter',
        run: () => {
          onExecuteRef.current()
          return true
        },
      },
      {
        key: 'Ctrl-Space',
        run: (view) => {
          startCompletion(view)
          return true
        },
      },
    ])

    const state = EditorState.create({
      doc: value,
      extensions: [
        executeKeymap,
        basicSetup,
        // Wrap long lines instead of horizontal scrolling — on touch devices the
        // inner horizontal pan is unreachable (nested scroll containers swallow
        // the gesture), leaving long SQL cut off at both edges.
        EditorView.lineWrapping,
        // lang-sql for syntax highlighting only — we override completion
        // entirely below so column suggestions work at every position.
        sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
        // Fixed positioning keeps the completion popup out of the wrapper's
        // `overflow-hidden` box — otherwise the list is clipped at the bottom
        // edge of the editor, which on a phone is most of the list.
        tooltips({ position: 'fixed' }),
        completionCompartment.current.of(completionExtension(completionSource)),
        themeCompartment.current.of(theme === 'dark' ? oneDark : []),
        cmPlaceholder(placeholder || ''),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newValue = update.state.doc.toString()
            externalValueRef.current = newValue
            onChangeRef.current(newValue)
          }
        }),
        EditorView.theme({
          // Fill the (bounded, resizable) wrapper; `.cm-scroller` is the single
          // internal scroller — see the wrapper's className below.
          '&': { fontSize: '13px', height: '100%' },
          '.cm-content': { fontFamily: 'ui-monospace, "JetBrains Mono", monospace' },
          '.cm-gutters': { borderRight: 'none' },
          '.cm-scroller': { overflow: 'auto' },
          '.cm-tooltip-autocomplete': {
            fontFamily: 'ui-monospace, "JetBrains Mono", monospace',
            borderRadius: '0.5rem',
            boxShadow: '0 10px 30px -10px rgb(0 0 0 / 0.45)',
          },
          '.cm-tooltip-autocomplete > ul': { maxHeight: '16rem' },
          '.cm-tooltip-autocomplete > ul > li': {
            padding: '3px 8px',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
          },
          '.cm-completionLabel': { flex: '0 1 auto', minWidth: 0 },
          '.cm-completionDetail': {
            color: '#94a3b8',
            fontStyle: 'normal',
            marginLeft: 'auto',
            paddingLeft: '0.75rem',
            fontSize: '0.85em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flex: '0 1 auto',
          },
          // Touch: taller rows, a list that is allowed to be tall, and no info
          // panel — on a narrow viewport it lands on top of the options it is
          // supposed to explain.
          '@media (max-width: 767px)': {
            '.cm-tooltip-autocomplete': { maxWidth: 'calc(100vw - 1.5rem)' },
            '.cm-tooltip-autocomplete > ul': { maxHeight: '45vh' },
            '.cm-tooltip-autocomplete > ul > li': { padding: '9px 10px', lineHeight: '1.25' },
            '.cm-completionInfo': { display: 'none' },
          },
        }),
      ],
    })

    const view = new EditorView({
      state,
      parent: containerRef.current,
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: themeCompartment.current.reconfigure(
        theme === 'dark' ? oneDark : [],
      ),
    })
  }, [theme])

  // Reconfigure the autocomplete source when the schema (re)loads so
  // column suggestions appear as soon as the schema fetch resolves.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: completionCompartment.current.reconfigure(completionExtension(completionSource)),
    })
  }, [completionSource])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (value !== externalValueRef.current) {
      externalValueRef.current = value
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: value,
        },
      })
    }
  }, [value])

  return (
    // The wrapper is the bounded, user-resizable box: `resize-y` puts a drag
    // grip at the bottom edge, `overflow-hidden` clips to its bounds (and is
    // what makes `resize` take effect), and min/default/max heights bound it.
    // `.cm-editor` fills it (`h-full`) and `.cm-scroller` scrolls internally, so
    // a query taller than the box scrolls instead of being clipped.
    <div
      ref={containerRef}
      className="resize-y overflow-hidden rounded-lg border border-border bg-card min-h-[160px] h-[220px] max-h-[70vh] md:h-[260px] [&_.cm-editor]:h-full"
    />
  )
}
