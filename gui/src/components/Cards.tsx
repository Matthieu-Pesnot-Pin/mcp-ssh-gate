import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Circle, CircleCheck, CircleX, Info, LoaderCircle, OctagonX, Pencil, Play, Sparkles, Square, X } from 'lucide-react'
import type { CommandRun, GateRequest } from '@shared/model'
import { api } from '../api'
import { clock, elapsed, plural, seconds } from '../format'
import { CommandText } from './CommandText'
import { ExplainableCommand } from './Explanations'

interface RequestCardProps {
  request: GateRequest
  /** Demandes en attente derrière celle-ci. */
  queued: number
  /** Une exécution occupe déjà le serveur. */
  busy: boolean
  onDone: () => void
  onError: (message: string) => void
}

/** Demande de l'agent en attente : commandes modifiables, note, refus ou exécution. */
export function RequestCard({ request, queued, busy, onDone, onError }: RequestCardProps) {
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const editRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setEditing(null)
    setNote('')
  }, [request.id])

  useEffect(() => {
    const field = editRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
  }, [draft, editing])

  async function act(fn: () => Promise<unknown>) {
    setSending(true)
    try {
      await fn()
      onDone()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  function startEdit(index: number) {
    setEditing(index)
    setDraft(request.commands[index].command)
    requestAnimationFrame(() => editRef.current?.focus())
  }

  async function saveEdit() {
    if (editing === null) return
    const index = editing
    await act(() => api.editCommand(request.id, index, draft))
    setEditing(null)
  }

  function onEditKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void saveEdit()
    } else if (event.key === 'Escape') {
      setEditing(null)
    }
  }

  const count = request.commands.length

  return (
    <section className="card">
      <div className="card-head">
        <Sparkles size={20} />
        <span className="card-title">L'agent demande {plural(count, 'commande')}</span>
        <span className="card-meta">
          {queued > 0 && <span className="queue-note">{plural(queued, 'autre demande', 'autres demandes')} en attente · </span>}
          {clock(request.createdAt)}
        </span>
      </div>

      {request.explanation && <p className="explanation">{request.explanation}</p>}

      <div className="cmd-list">
        {request.commands.map((command, index) => (
          <div key={index} className={`cmd-row${editing === index ? ' editing' : ''}`}>
            <span className="cmd-num">{index + 1}</span>
            <div style={{ minWidth: 0 }}>
              {editing === index ? (
                <textarea ref={editRef} className="cmd-edit" rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onEditKey} />
              ) : (
                <div className="cmd-text">
                  <ExplainableCommand request={request} commandIndex={index} onChanged={onDone} onError={onError} />
                </div>
              )}
              {command.original !== null && editing !== index && <div className="cmd-original">Modifiée par toi — l'agent proposait : {command.original}</div>}
            </div>
            <div className="cmd-actions">
              {editing === index ? (
                <>
                  <span className="cmd-hint">Entrée · Échap</span>
                  <button className="icon-btn" title="Valider" onClick={() => void saveEdit()} disabled={sending}>
                    <Check size={18} color="var(--accent-soft)" />
                  </button>
                  <button className="icon-btn" title="Annuler" onClick={() => setEditing(null)}>
                    <X size={18} />
                  </button>
                </>
              ) : (
                <>
                  <button className="icon-btn" title="Modifier" onClick={() => startEdit(index)} disabled={sending}>
                    <Pencil size={18} />
                  </button>
                  {count > 1 && (
                    <button className="icon-btn" title="Retirer" onClick={() => void act(() => api.removeCommand(request.id, index))} disabled={sending}>
                      <X size={18} />
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div>
        <div className="field-label">Note pour l'agent (facultatif)</div>
        <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Jointe au résultat, ou motif du refus" />
      </div>

      <div className="card-foot">
        <span className="hint">
          <Info size={16} />
          {busy ? 'Une exécution est en cours sur ce serveur.' : `Exécutées dans l'ordre, dans le shell ouvert. Arrêt à la première erreur.`}
        </span>
        <button className="btn btn-secondary" onClick={() => void act(() => api.refuse(request.id, note))} disabled={sending || editing !== null}>
          Refuser
        </button>
        <button className="btn btn-primary" onClick={() => void act(() => api.approve(request.id, note))} disabled={sending || busy || editing !== null}>
          <Play size={16} />
          {count > 1 ? `Exécuter les ${count} commandes` : 'Exécuter la commande'}
        </button>
      </div>
    </section>
  )
}

function StepIcon({ command }: { command: CommandRun }) {
  switch (command.status) {
    case 'succeeded':
      return <CircleCheck size={18} className="status-ok" />
    case 'failed':
      return <CircleX size={18} className="status-ko" />
    case 'interrupted':
      return <OctagonX size={18} className="status-ko" />
    case 'running':
      return <LoaderCircle size={18} className="status-run spin" />
    default:
      return <Circle size={18} className="status-idle" />
  }
}

function stepMeta(command: CommandRun): string {
  switch (command.status) {
    case 'running':
      return 'en cours'
    case 'pending':
      return 'en attente'
    case 'skipped':
      return 'non exécutée'
    case 'interrupted':
      return 'interrompue'
    default:
      return [command.exitCode === null ? '' : `code ${command.exitCode}`, seconds(command.startedAt, command.endedAt)].filter(Boolean).join(' · ')
  }
}

interface RunCardProps {
  request: GateRequest
  onError: (message: string) => void
}

/** Exécution en cours : avancement du lot, sortie en direct, interruption. */
export function RunCard({ request, onError }: RunCardProps) {
  const [now, setNow] = useState(Date.now())
  const [stopping, setStopping] = useState(false)
  const outputRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const currentIndex = request.commands.findIndex((c) => c.status === 'running')
  const shownIndex = currentIndex === -1 ? Math.max(0, request.commands.findLastIndex((c) => c.status !== 'pending')) : currentIndex
  const shown = request.commands[shownIndex]

  useEffect(() => {
    const box = outputRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [shown?.output])

  async function interrupt() {
    setStopping(true)
    try {
      await api.interrupt(request.id)
    } catch (err) {
      onError((err as Error).message)
      setStopping(false)
    }
  }

  const total = request.commands.length
  const title = total > 1 ? `Exécution — commande ${shownIndex + 1} sur ${total}` : 'Exécution en cours'

  return (
    <section className="card">
      <div className="card-head">
        <LoaderCircle size={20} className="spin" />
        <span className="card-title">{title}</span>
        <span className="card-meta">
          lancée à {clock(request.decidedAt)} · {elapsed(request.decidedAt, now)}
        </span>
      </div>

      {total > 1 && (
        <div className="cmd-list" style={{ gap: 4 }}>
          {request.commands.map((command, index) => (
            <div key={index} className={`step-row${command.status === 'running' ? ' current' : ''}${command.status === 'pending' ? ' waiting' : ''}`}>
              <StepIcon command={command} />
              <span className="cmd-text" title={command.command}>
                <CommandText command={command.command} />
              </span>
              <span className="step-meta" style={command.status === 'running' ? { color: 'var(--accent-soft)' } : undefined}>
                {stepMeta(command)}
              </span>
            </div>
          ))}
        </div>
      )}

      {shown && (
        <div>
          <div className="field-label">{total > 1 ? `Sortie de la commande ${shownIndex + 1}` : <span className="mono"><CommandText command={shown.command} /></span>}</div>
          <div className="output-box flush" ref={outputRef} style={{ minHeight: 120 }}>
            {shown.output}
            {shown.status === 'running' && <span className="cursor" />}
          </div>
        </div>
      )}

      <div className="card-foot">
        <span className="hint">
          <Info size={16} />
          {request.source === 'agent' ? "L'agent reçoit le résultat complet dès la fin du lot, avec ta note s'il y en a une." : 'Commande saisie par toi : son résultat reste visible par l’agent dans l’historique.'}
        </span>
        <button className="btn btn-danger" onClick={() => void interrupt()} disabled={stopping}>
          <Square size={14} strokeWidth={2.5} />
          {stopping ? 'Interruption…' : 'Interrompre (Ctrl+C)'}
        </button>
      </div>
    </section>
  )
}
