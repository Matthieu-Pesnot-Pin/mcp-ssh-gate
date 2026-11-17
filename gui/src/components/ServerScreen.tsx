import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Ban, Bot, CornerDownLeft, Ellipsis, Folder, KeyRound, NotebookPen, Pencil, Power, RefreshCw, Server, Trash2, Unplug, User } from 'lucide-react'
import { isReady, type GateRequest, type RequestEvaluation, type SegmentEvaluation, type ServerView, type SessionView } from '@shared/model'
import { api } from '../api'
import { ago, plural } from '../format'
import { usePolling } from '../usePolling'
import { Journal } from './Journal'
import { RequestCard, RunCard } from './Cards'
import { NotesView } from './NotesView'
import { RuleModal, type RuleOrigin } from './Whitelist'

interface Authorizing {
  segment: SegmentEvaluation
  origin: RuleOrigin
}

interface MenuProps {
  server: ServerView
  onChanged: () => void
  onError: (message: string) => void
  onShowKey: () => void
  onInstallKey: () => void
  onRotate: () => void
  onRevoke: () => void
  onEdit: () => void
  onDelete: () => void
}

interface Props extends MenuProps {
  session: SessionView
}

function ServerMenu({ server, onChanged, onError, onShowKey, onInstallKey, onRotate, onRevoke, onEdit, onDelete }: MenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  function pick(fn: () => void) {
    setOpen(false)
    fn()
  }

  async function disconnect() {
    try {
      await api.disconnect(server.id)
      onChanged()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  return (
    <div className="menu-anchor" ref={ref}>
      <button className="icon-btn" title="Actions" onClick={() => setOpen(!open)}>
        <Ellipsis size={22} />
      </button>
      {open && (
        <div className="menu">
          {server.publicKey ? (
            <>
              <button onClick={() => pick(onShowKey)}>
                <KeyRound size={16} />
                Installation et test
              </button>
              <button onClick={() => pick(onRotate)} disabled={server.busy || !server.hostKeyFingerprint}>
                <RefreshCw size={16} />
                Renouveler la clé
              </button>
            </>
          ) : (
            <button onClick={() => pick(onInstallKey)}>
              <KeyRound size={16} />
              Installer une clé
            </button>
          )}
          <button onClick={() => pick(onEdit)}>
            <Pencil size={16} />
            Modifier
          </button>
          {server.sessions.some((s) => s.shell === 'connected') && (
            <button onClick={() => pick(() => void disconnect())} disabled={server.busy}>
              <Unplug size={16} />
              Fermer les shells
            </button>
          )}
          {server.publicKey && (
            <button className="danger" onClick={() => pick(onRevoke)} disabled={server.busy}>
              <Ban size={16} />
              Révoquer la clé
            </button>
          )}
          <button className="danger" onClick={() => pick(onDelete)} disabled={server.busy}>
            <Trash2 size={16} />
            Supprimer
          </button>
        </div>
      )}
    </div>
  )
}

interface PromptProps {
  server: ServerView
  session: SessionView
  disabledReason: string | null
  onRun: () => void
  onError: (m: string) => void
}

function ManualPrompt({ server, session, disabledReason, onRun, onError }: PromptProps) {
  const [command, setCommand] = useState('')
  const [sending, setSending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const refocus = useRef(false)

  useEffect(() => {
    if (refocus.current && !disabledReason && !sending) inputRef.current?.focus()
  }, [disabledReason, sending])

  async function submit() {
    const text = command.trim()
    if (!text || disabledReason) return
    setSending(true)
    refocus.current = true
    try {
      await api.runManual(server.id, session.id, text)
      setCommand('')
      onRun()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <div className={`prompt${disabledReason ? ' disabled' : ''}`}>
      <span className="prompt-sign">$</span>
      <input
        ref={inputRef}
        onBlur={() => {
          if (!inputRef.current?.disabled) refocus.current = false
        }}
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={onKey}
        disabled={!!disabledReason || sending}
        placeholder={disabledReason ?? (session.id === null ? 'Taper une commande à exécuter toi-même' : `Taper une commande à exécuter dans la session ${session.name}`)}
      />
      <button className="icon-btn" title="Exécuter" onClick={() => void submit()} disabled={!!disabledReason || sending || !command.trim()}>
        <CornerDownLeft size={20} />
      </button>
    </div>
  )
}

/** Fermeture d'une session d'agent ; avec des demandes en attente, une confirmation dit qu'elles seront retirées. */
function CloseSessionButton({ session, onClosed, onError }: { session: SessionView; onClosed: () => void; onError: (m: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const [closing, setClosing] = useState(false)

  async function close() {
    setClosing(true)
    try {
      await api.closeSession(session.id!)
      onClosed()
    } catch (err) {
      onError((err as Error).message)
      setClosing(false)
      setConfirming(false)
    }
  }

  if (confirming) {
    return (
      <div className="session-confirm">
        <span>{plural(session.pendingCount, 'demande en attente sera retirée', 'demandes en attente seront retirées')}</span>
        <button className="btn btn-secondary btn-sm" onClick={() => setConfirming(false)} disabled={closing}>
          Annuler
        </button>
        <button className="btn btn-danger btn-sm" onClick={() => void close()} disabled={closing}>
          Fermer la session
        </button>
      </div>
    )
  }
  return (
    <button
      className="btn btn-secondary session-close"
      onClick={() => (session.pendingCount > 0 ? setConfirming(true) : void close())}
      disabled={session.busy || closing}
      title={session.busy ? 'Une commande s’exécute dans cette session' : undefined}
    >
      <Power size={16} />
      Fermer la session
    </button>
  )
}

/**
 * Écran d'une session : le bandeau du serveur (commun à toutes ses sessions, avec ses
 * notes), puis la session choisie — son historique, sa demande en attente ou son
 * exécution en cours, et la saisie manuelle dans son shell.
 */
export function ServerScreen(props: Props) {
  const { server, session, onChanged, onError, onShowKey, onInstallKey } = props
  const active = session.busy || session.pendingCount > 0
  const polled = usePolling(`requests:${server.id}:${session.id ?? ''}`, () => api.requests(server.id, session.id), active ? 1000 : 2500)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [notesOpen, setNotesOpen] = useState(false)
  const [authorizing, setAuthorizing] = useState<Authorizing | null>(null)

  const requests: GateRequest[] = polled.data?.requests ?? []
  const finished = requests.filter((r) => r.status !== 'pending' && r.status !== 'running')
  const running = requests.find((r) => r.status === 'running') ?? null
  const pending = requests.filter((r) => r.status === 'pending')
  const evaluation: RequestEvaluation | null = pending[0] ? polled.data?.evaluations[pending[0].id] ?? null : null

  function authorize(commandIndex: number, segment: SegmentEvaluation) {
    if (!evaluation) return
    const others = evaluation.commands.flatMap((command, index) =>
      command.segments.filter((other) => other.verdict !== 'covered' && !(index === commandIndex && other === segment)).map((other) => other.text)
    )
    setAuthorizing({ segment, origin: { text: segment.text, sessionName: session.name, otherPending: others } })
  }

  const lastSignature = requests.length ? `${requests[requests.length - 1].id}:${requests[requests.length - 1].status}:${running?.commands.map((c) => c.output.length).join(',')}` : ''

  useLayoutEffect(() => {
    const box = scrollRef.current
    if (box && stickToBottom.current) box.scrollTop = box.scrollHeight
  }, [lastSignature, server.id, session.id])

  function refresh() {
    polled.reload()
    onChanged()
  }

  const tested = isReady(server)
  const isAgent = session.id !== null
  const disabledReason = !server.publicKey
    ? 'Clé révoquée : installe une nouvelle clé pour exécuter des commandes'
    : !tested
    ? 'Teste la connexion avant d’exécuter des commandes'
    : running
      ? 'Disponible à la fin de l’exécution'
      : null

  return (
    <main className="main">
      <header className="server-band">
        <Server size={16} className="server-band-icon" />
        <span className="server-band-name">{server.name}</span>
        <span className="server-band-host">
          {server.username}@{server.host}
          {server.port !== 22 ? `:${server.port}` : ''}
        </span>
        <span className="topbar-spacer" />
        <button className={`btn btn-secondary btn-sm${notesOpen ? ' active' : ''}`} onClick={() => setNotesOpen(!notesOpen)} aria-pressed={notesOpen}>
          <NotebookPen size={14} />
          Notes du serveur
        </button>
        <ServerMenu {...props} />
      </header>

      <div className="session-area">
        <div className="session-column">
          <div className="session-head">
            <div style={{ minWidth: 0 }}>
              <div className="session-title">
                {session.name}
                <span className={`chip chip-sm${isAgent ? ' agent' : ''}`}>
                  {isAgent ? <Bot size={12} /> : <User size={12} />}
                  {isAgent ? 'Agent' : 'Ta session'}
                </span>
              </div>
              <div className="session-meta">
                <Folder size={13} />
                <span className="mono">{session.cwd ?? 'shell fermé'}</span>
                <span className="session-meta-sep">·</span>
                <span>
                  {isAgent
                    ? `Ouverte par un agent ${ago(session.openedAt!)} · dossier et variables propres à cette session`
                    : 'Tes commandes manuelles ; aucun agent ne les reçoit'}
                </span>
              </div>
            </div>
            <span className="topbar-spacer" />
            {isAgent && <CloseSessionButton key={session.id} session={session} onClosed={onChanged} onError={onError} />}
          </div>

          <div
            className="content"
            ref={scrollRef}
            onScroll={(e) => {
              const box = e.currentTarget
              stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
            }}
          >
            {!server.publicKey ? (
              <div className="banner">
                <KeyRound size={18} />
                <span>La clé de ce serveur a été révoquée : SSH Gate n'y a plus accès.</span>
                <button className="btn btn-secondary" onClick={onInstallKey}>
                  Installer une clé
                </button>
              </div>
            ) : (
              !tested && (
                <div className="banner">
                  <KeyRound size={18} />
                  <span>La connexion à ce serveur n'a jamais été testée. Colle la commande d'installation sur le serveur, puis teste la connexion.</span>
                  <button className="btn btn-secondary" onClick={onShowKey}>
                    Installation et test
                  </button>
                </div>
              )
            )}
            {polled.error && !polled.data && <div className="empty-journal">{polled.error}</div>}
            {polled.data && <Journal requests={finished} onChanged={refresh} onError={onError} />}
            {running && <RunCard request={running} onError={onError} />}
            {pending[0] && (
              <RequestCard
                request={pending[0]}
                queued={pending.length - 1}
                busy={session.busy || !!running}
                evaluation={evaluation}
                onAuthorize={authorize}
                onDone={refresh}
                onError={onError}
              />
            )}
          </div>

          <footer className="footer">
            <ManualPrompt server={server} session={session} disabledReason={disabledReason} onRun={refresh} onError={onError} />
          </footer>
        </div>

        {authorizing && (
          <RuleModal
            servers={[server]}
            scopes={[null, server.id]}
            initialScope={server.id}
            command={authorizing.segment.command ?? ''}
            prefillForm={authorizing.segment.args ? authorizing.segment.args : null}
            prefillSudo={authorizing.segment.sudo}
            origin={authorizing.origin}
            onClose={() => setAuthorizing(null)}
            onSaved={refresh}
          />
        )}

        {notesOpen && (
          <aside className="notes-panel">
            <NotesView server={server} onSaved={onChanged} onClose={() => setNotesOpen(false)} />
          </aside>
        )}
      </div>
    </main>
  )
}
