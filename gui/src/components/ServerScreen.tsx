import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Ban, CornerDownLeft, Ellipsis, KeyRound, Pencil, RefreshCw, Trash2, Unplug } from 'lucide-react'
import { isReady, type GateRequest, type ServerView } from '@shared/model'
import { api } from '../api'
import { usePolling } from '../usePolling'
import { Journal } from './Journal'
import { RequestCard, RunCard } from './Cards'
import { NotesView } from './NotesView'

interface Props {
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

function ServerMenu({ server, onChanged, onError, onShowKey, onInstallKey, onRotate, onRevoke, onEdit, onDelete }: Props) {
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
          {server.session === 'connected' && (
            <button onClick={() => pick(() => void disconnect())} disabled={server.busy}>
              <Unplug size={16} />
              Fermer le shell
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

function ManualPrompt({ server, disabledReason, onRun, onError }: { server: ServerView; disabledReason: string | null; onRun: () => void; onError: (m: string) => void }) {
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
      await api.runManual(server.id, text)
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
        placeholder={disabledReason ?? 'Taper une commande à exécuter toi-même'}
      />
      <button className="icon-btn" title="Exécuter" onClick={() => void submit()} disabled={!!disabledReason || sending || !command.trim()}>
        <CornerDownLeft size={20} />
      </button>
    </div>
  )
}

/** Session d'un serveur : historique, demande en attente ou exécution en cours, saisie manuelle. */
export function ServerScreen(props: Props) {
  const { server, onChanged, onError, onShowKey, onInstallKey } = props
  const active = server.busy || server.pendingCount > 0
  const polled = usePolling(`requests:${server.id}`, () => api.requests(server.id), active ? 1000 : 2500)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const requests: GateRequest[] = polled.data?.requests ?? []
  const finished = requests.filter((r) => r.status !== 'pending' && r.status !== 'running')
  const running = requests.find((r) => r.status === 'running') ?? null
  const pending = requests.filter((r) => r.status === 'pending')

  const lastSignature = requests.length ? `${requests[requests.length - 1].id}:${requests[requests.length - 1].status}:${running?.commands.map((c) => c.output.length).join(',')}` : ''

  useLayoutEffect(() => {
    const box = scrollRef.current
    if (box && stickToBottom.current) box.scrollTop = box.scrollHeight
  }, [lastSignature, server.id])

  function refresh() {
    polled.reload()
    onChanged()
  }

  const [tab, setTab] = useState<'session' | 'notes'>('session')

  const tested = isReady(server)
  const disabledReason = !server.publicKey
    ? 'Clé révoquée : installe une nouvelle clé pour exécuter des commandes'
    : !tested
    ? 'Teste la connexion avant d’exécuter des commandes'
    : running
      ? 'Disponible à la fin de l’exécution'
      : null

  return (
    <main className="main">
      <header className="topbar">
        <div style={{ minWidth: 0 }}>
          <div className="topbar-title">{server.name}</div>
          <div className="topbar-sub">
            {server.username}@{server.host}
            {server.port !== 22 ? `:${server.port}` : ''}
            {server.cwd ? ` · shell ouvert dans ${server.cwd}` : ''}
          </div>
        </div>
        <span className="topbar-spacer" />
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'session'} className={`tab${tab === 'session' ? ' active' : ''}`} onClick={() => setTab('session')}>
            Session
            {server.pendingCount > 0 && <span className="badge tab-badge">{server.pendingCount}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'notes'} className={`tab${tab === 'notes' ? ' active' : ''}`} onClick={() => setTab('notes')}>
            Notes
          </button>
        </div>
        {server.session === 'connected' ? (
          <span className="chip ok">
            <span className="dot on" />
            Connecté
          </span>
        ) : (
          <span className="chip">
            <span className="dot" />
            {!server.publicKey ? 'Clé révoquée' : tested ? 'Shell fermé' : 'Non testé'}
          </span>
        )}
        <ServerMenu {...props} />
      </header>

      {tab === 'notes' && (
        <div className="content">
          <NotesView server={server} onSaved={onChanged} />
        </div>
      )}

      <div
        className="content"
        style={tab === 'session' ? undefined : { display: 'none' }}
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
        {polled.data && <Journal requests={finished} onShared={refresh} onError={onError} />}
        {running && <RunCard request={running} onError={onError} />}
        {pending[0] && <RequestCard request={pending[0]} queued={pending.length - 1} busy={server.busy || !!running} onDone={refresh} onError={onError} />}
      </div>

      <footer className="footer" style={tab === 'session' ? undefined : { display: 'none' }}>
        <ManualPrompt server={server} disabledReason={disabledReason} onRun={refresh} onError={onError} />
      </footer>
    </main>
  )
}
