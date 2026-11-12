import { useContext, useMemo, useState, type MouseEvent } from 'react'
import { LoaderCircle, MessageCircleQuestionMark, Sparkles, X } from 'lucide-react'
import type { CommandQuestion, GateRequest } from '@shared/model'
import { api } from '../api'
import { CommandText, LineBreakContext, commandStatements } from './CommandText'

/** Un clic dans un bouton ou un encadré d'explication ne déplie ni ne replie l'entrée du journal. */
function stop(event: MouseEvent) {
  event.stopPropagation()
}

interface PanelProps {
  question: CommandQuestion
  /** Instruction rappelée au-dessus de la réponse, quand l'encadré n'est pas sous elle. */
  statement?: string
  busy: boolean
  onHide: () => void
  onCancel: () => void
}

/** Question en attente de l'agent, ou sa réponse. */
function QuestionPanel({ question, statement, busy, onHide, onCancel }: PanelProps) {
  if (question.answer === null) {
    return (
      <div className="explain-panel waiting" onClick={stop}>
        <LoaderCircle size={14} className="spin explain-icon" />
        <span className="explain-wait">
          {statement && <span className="explain-statement">{statement}</span>}
          Question envoyée à l'agent, en attente de sa réponse…
        </span>
        <button className="link-btn" onClick={onCancel} disabled={busy}>
          Annuler
        </button>
      </div>
    )
  }
  return (
    <div className="explain-panel" onClick={stop}>
      <div className="explain-head">
        <Sparkles size={14} className="explain-icon" />
        <span>Explication de l'agent</span>
        <button className="icon-btn explain-hide" title="Masquer" onClick={onHide}>
          <X size={16} />
        </button>
      </div>
      {statement && <div className="explain-statement">{statement}</div>}
      <div className="explain-text">{question.answer}</div>
    </div>
  )
}

interface Props {
  request: GateRequest
  commandIndex: number
  onChanged: () => void
  onError: (message: string) => void
}

/**
 * Commande affichée en entier, avec ses explications. En mode "auto", chaque instruction
 * a son bouton Expliquer et son explication juste dessous ; en mode "brut", il n'y a pas
 * de bouton et les explications déjà demandées suivent la commande.
 */
export function ExplainableCommand({ request, commandIndex, onChanged, onError }: Props) {
  const mode = useContext(LineBreakContext)
  const command = request.commands[commandIndex].command
  const statements = useMemo(() => commandStatements(command), [command])
  const questions = request.questions.filter((question) => question.commandIndex === commandIndex)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    try {
      await fn()
      onChanged()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const hide = (id: string) => setHidden(new Set([...hidden, id]))
  const reveal = (id: string) => setHidden(new Set([...hidden].filter((other) => other !== id)))
  const panel = (question: CommandQuestion, statement?: string) => (
    <QuestionPanel
      key={question.id}
      question={question}
      statement={statement}
      busy={busy}
      onHide={() => hide(question.id)}
      onCancel={() => void run(() => api.cancelQuestion(request.id, question.id))}
    />
  )

  if (mode !== 'auto') {
    const shown = questions.filter((question) => !hidden.has(question.id))
    return (
      <>
        <CommandText command={command} full />
        {shown.length > 0 && <div className="explain-list">{shown.map((question) => panel(question, question.statement))}</div>}
      </>
    )
  }

  return (
    <div className="hl stmts">
      {statements.map((statement, index) => {
        const question = questions.find((q) => q.statement === statement.text)
        const open = question !== undefined && !hidden.has(question.id)
        return (
          <div key={index} className="stmt">
            <div className="stmt-line">
              <span className="stmt-code">{statement.nodes}</span>
              {!open && (
                <button
                  className="stmt-explain"
                  disabled={busy}
                  onClick={(event) => {
                    stop(event)
                    if (question) reveal(question.id)
                    else void run(() => api.askQuestion(request.id, commandIndex, statement.text))
                  }}
                >
                  <MessageCircleQuestionMark size={14} />
                  Expliquer
                </button>
              )}
            </div>
            {open && panel(question)}
          </div>
        )
      })}
    </div>
  )
}
