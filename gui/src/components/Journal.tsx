import { useState } from 'react'
import { Ban, Check, ChevronDown, ChevronRight, CircleCheck, CircleSlash, CircleX, OctagonX, Send } from 'lucide-react'
import type { CommandRun, GateRequest } from '@shared/model'
import { api } from '../api'
import { clock, plural, seconds } from '../format'
import { CommandText } from './CommandText'

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

function CommandEntry({ request, command, defaultOpen }: { request: GateRequest; command: CommandRun; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const ran = command.status !== 'skipped'
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div className="entry">
      <button className="entry-head" onClick={() => ran && setOpen(!open)} disabled={!ran} style={{ opacity: 1 }}>
        <span className="entry-actor">{actor(request)}</span>
        <span className="entry-time">{clock(command.startedAt ?? request.createdAt)}</span>
        <span className={`entry-cmd${ran ? '' : ' dim'}`} title={command.command}>
          {ran ? <CommandText command={command.command} /> : command.command}
        </span>
        <span className="entry-status">
          {statusText(command)}
          <StatusIcon command={command} />
        </span>
        {ran ? <Chevron size={18} className="status-idle" /> : <span />}
      </button>
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

/** Demande refusée ou retirée : une seule ligne, avec le motif. */
function ClosedEntry({ request }: { request: GateRequest }) {
  const label =
    request.status === 'refused'
      ? `${plural(request.commands.length, 'commande refusée', 'commandes refusées')}`
      : `${plural(request.commands.length, 'commande retirée', 'commandes retirées')} par l'agent`
  return (
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
  )
}

/** Commande saisie par l'utilisateur : envoi du résultat aux agents, une seule fois. */
function ShareRow({ request, onShared, onError }: { request: GateRequest; onShared: () => void; onError: (message: string) => void }) {
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
  onShared: () => void
  onError: (message: string) => void
}

/** Historique du serveur : les demandes terminées, les plus anciennes en haut. */
export function Journal({ requests, onShared, onError }: Props) {
  if (requests.length === 0) {
    return <div className="empty-journal">Aucune commande exécutée sur ce serveur pour l'instant.</div>
  }
  const latestId = requests[requests.length - 1].id

  return (
    <>
      {requests.map((request) => {
        if (request.status === 'refused' || request.status === 'cancelled') return <ClosedEntry key={request.id} request={request} />
        return (
          <div key={request.id} style={{ display: 'contents' }}>
            {request.commands.map((command, index) => (
              <CommandEntry
                key={`${request.id}:${index}`}
                request={request}
                command={command}
                defaultOpen={request.id === latestId && command.status !== 'skipped'}
              />
            ))}
            {(request.note || request.error) && (
              <div className="entry-note" style={{ padding: '0 16px 4px 120px' }}>
                {request.error && <div className="status-ko">{request.error}</div>}
                {request.note && <div>Note pour l'agent : {request.note}</div>}
              </div>
            )}
            {request.source === 'user' && <ShareRow request={request} onShared={onShared} onError={onError} />}
          </div>
        )
      })}
    </>
  )
}
