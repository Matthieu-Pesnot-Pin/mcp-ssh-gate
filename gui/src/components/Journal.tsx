import { useState } from 'react'
import { Ban, Check, ChevronDown, ChevronRight, CircleCheck, CircleSlash, CircleX, OctagonX, Send, ShieldCheck } from 'lucide-react'
import type { CommandRun, GateRequest } from '@shared/model'
import { api } from '../api'
import { clock, plural, seconds } from '../format'
import { CommandText } from './CommandText'
import { ExplainableCommand } from './Explanations'

function StatusIcon({ command }: { command: CommandRun }) {
  switch (command.status) {
    case 'succeeded':
      return <CircleCheck size={18} className="status-ok" />
    case 'failed':
      return <CircleX size={18} className="status-ko" />
    case 'interrupted':
      return <OctagonX size={18} className="status-ko" />
    default:
      return <CircleSlash size={18} className="status-idle" />
  }
}

function statusText(command: CommandRun): string {
  if (command.status === 'skipped') return 'non exécutée'
  if (command.status === 'interrupted') return 'interrompue'
  const parts = [command.exitCode === null ? '' : `code ${command.exitCode}`, seconds(command.startedAt, command.endedAt)].filter(Boolean)
  return parts.join(' · ')
}

function actor(request: GateRequest): string {
  return request.source === 'user' ? 'Toi' : 'Agent'
}

interface EntryProps {
  request: GateRequest
  index: number
  defaultOpen: boolean
  onChanged: () => void
  onError: (message: string) => void
}

function CommandEntry({ request, index, defaultOpen, onChanged, onError }: EntryProps) {
  const command = request.commands[index]
  const [open, setOpen] = useState(defaultOpen)
  const ran = command.status !== 'skipped'
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="entry">
      <div
        className={`entry-head${open ? ' open' : ''}${ran ? ' toggles' : ''}`}
        role={ran ? 'button' : undefined}
        tabIndex={ran ? 0 : undefined}
        aria-expanded={ran ? open : undefined}
        onClick={() => ran && setOpen(!open)}
        onKeyDown={(event) => {
          if (!ran || event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          setOpen(!open)
        }}
      >
        <span className="entry-actor">{actor(request)}</span>
        <span className="entry-time">{clock(command.startedAt ?? request.createdAt)}</span>
        <div className={`entry-cmd${ran ? '' : ' dim'}`} title={open ? undefined : command.command}>
          {!ran ? command.command : open ? <ExplainableCommand request={request} commandIndex={index} onChanged={onChanged} onError={onError} /> : <CommandText command={command.command} />}
        </div>
        <span className="entry-status">
          {request.autoApproval && (
            <span className="chip-auto" title={`Règles : ${request.autoApproval.rules.join(', ')}`}>
              <ShieldCheck size={12} />
              Auto · liste blanche
            </span>
          )}
          {statusText(command)}
          <StatusIcon command={command} />
        </span>
        {ran ? <Chevron size={18} className="status-idle" /> : <span />}
      </div>
      {command.original !== null && <div className="entry-note">Modifiée par toi — l'agent proposait : {command.original}</div>}
      {open && (
        <div className="output-box">
          {command.outputTruncated && <div className="muted">[début de la sortie écarté]</div>}
          {command.output.trim() ? command.output.replace(/\s+$/, '') : <span className="muted">(aucune sortie)</span>}
        </div>
      )}
    </div>
  )
}

/** Explication donnée par l'agent avec sa demande. */
function RequestExplanation({ request }: { request: GateRequest }) {
  if (!request.explanation) return null
  return <p className="journal-explanation">{request.explanation}</p>
}

/** Demande refusée ou retirée : une seule ligne, avec le motif. */
function ClosedEntry({ request }: { request: GateRequest }) {
  const label =
    request.status === 'refused'
      ? `${plural(request.commands.length, 'commande refusée', 'commandes refusées')}`
      : `${plural(request.commands.length, 'commande retirée', 'commandes retirées')} par l'agent`
  return (
    <div style={{ display: 'contents' }}>
      <RequestExplanation request={request} />
      <div className="entry">
        <div className="entry-head">
          <span className="entry-actor">{actor(request)}</span>
          <span className="entry-time">{clock(request.createdAt)}</span>
          <span className="entry-cmd dim" title={request.commands.map((c) => c.command).join('\n')}>
            {request.commands.map((c) => c.command).join('  ·  ')}
          </span>
          <span className="entry-status">
            {label}
            <Ban size={18} className="status-idle" />
          </span>
          <span />
        </div>
        {request.note && <div className="entry-note">Motif : {request.note}</div>}
      </div>
    </div>
  )
}

/** Commande saisie par l'utilisateur dans une session d'agent : envoi du résultat à cet agent, une seule fois. */
function ShareRow({ request, readOnly, onShared, onError }: { request: GateRequest; readOnly: boolean; onShared: () => void; onError: (message: string) => void }) {
  const [sending, setSending] = useState(false)

  async function share() {
    setSending(true)
    try {
      await api.share(request.id)
      onShared()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  if (readOnly && !request.sharedAt) return null

  return (
    <div className="share-row">
      {request.sharedAt ? (
        <span className="share-done">
          <Check size={14} />
          Envoyée à l'agent à {clock(request.sharedAt)}
        </span>
      ) : (
        <button className="btn btn-secondary btn-sm" onClick={() => void share()} disabled={sending}>
          <Send size={14} />
          Envoyer à l'agent
        </button>
      )}
    </div>
  )
}

interface Props {
  requests: GateRequest[]
  /** Session fermée : plus rien n'est envoyé à l'agent. */
  readOnly: boolean
  onChanged: () => void
  onError: (message: string) => void
}

/** Historique d'une session : ses demandes terminées, les plus anciennes en haut. */
export function Journal({ requests, readOnly, onChanged, onError }: Props) {
  if (requests.length === 0) {
    return <div className="empty-journal">Aucune commande exécutée dans cette session.</div>
  }
  const latestId = requests[requests.length - 1].id

  return (
    <>
      {requests.map((request) => {
        if (request.status === 'refused' || request.status === 'cancelled') return <ClosedEntry key={request.id} request={request} />
        return (
          <div key={request.id} style={{ display: 'contents' }}>
            <RequestExplanation request={request} />
            {request.commands.map((command, index) => (
              <CommandEntry
                key={`${request.id}:${index}`}
                request={request}
                index={index}
                defaultOpen={request.id === latestId && command.status !== 'skipped'}
                onChanged={onChanged}
                onError={onError}
              />
            ))}
            {(request.note || request.error) && (
              <div className="entry-note" style={{ padding: '0 16px 4px 120px' }}>
                {request.error && <div className="status-ko">{request.error}</div>}
                {request.note && <div>Note pour l'agent : {request.note}</div>}
              </div>
            )}
            {request.source === 'user' && request.sessionId !== null && <ShareRow request={request} readOnly={readOnly} onShared={onChanged} onError={onError} />}
          </div>
        )
      })}
    </>
  )
}
