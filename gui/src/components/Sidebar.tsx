import { useRef, useState, type PointerEvent } from 'react'
import { Bot, ChevronDown, ChevronRight, LoaderCircle, Plus, Settings, SquareTerminal, Terminal, User } from 'lucide-react'
import type { ServerView, SessionView, TerminalView } from '@shared/model'
import { SIDEBAR_DEFAULT_WIDTH } from '../prefs'

interface Props {
  width: number
  onResize: (width: number) => void
  servers: ServerView[]
  selectedId: string | null
  selectedSessionId: string | null
  /** Vue Terminaux affichée : null si aucune, serverId null pour celle de tous les serveurs. */
  terminalsView: { serverId: string | null } | null
  terminals: TerminalView[]
  onSelect: (id: string) => void
  onSelectSession: (serverId: string, sessionId: string | null) => void
  onOpenTerminals: (serverId: string | null) => void
  onAdd: () => void
  onSettings: () => void
}

function subtitle(server: ServerView): string {
  if (!server.publicKey) return 'clé révoquée'
  if (!server.hostKeyFingerprint) return 'connexion à tester'
  return `${server.username}@${server.host}`
}

function SessionState({ session }: { session: SessionView }) {
  if (session.busy) return <LoaderCircle size={14} className="spin status-run" aria-label="Exécution en cours" />
  if (session.pendingCount > 0) return <span className="badge badge-sm">{session.pendingCount}</span>
  return <span />
}

/** Poignée du bord droit : glisser change la largeur, un double-clic rend la largeur par défaut. */
function ResizeHandle({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null)

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: event.clientX, startWidth: width }
    document.body.classList.add('resizing')
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current) onResize(drag.current.startWidth + event.clientX - drag.current.startX)
  }

  function onPointerUp() {
    drag.current = null
    document.body.classList.remove('resizing')
  }

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      title="Glisser pour redimensionner, double-clic pour la largeur par défaut"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onResize(SIDEBAR_DEFAULT_WIDTH)}
    />
  )
}

/**
 * Barre latérale : les terminaux de tous les serveurs, puis les serveurs. Sous chaque
 * serveur, déplié par son chevron : ses terminaux, ta session, puis celles des agents.
 * Un clic sur la ligne d'un serveur ouvre son onglet sans le déplier.
 */
export function Sidebar({ width, onResize, servers, selectedId, selectedSessionId, terminalsView, terminals, onSelect, onSelectSession, onOpenTerminals, onAdd, onSettings }: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  function toggle(id: string) {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <Terminal size={22} />
        SSH Gate
      </div>
      <button className={`nav-row${terminalsView?.serverId === null ? ' selected' : ''}`} onClick={() => onOpenTerminals(null)}>
        <SquareTerminal size={20} />
        <span>Terminaux</span>
        {terminals.length > 0 ? <span className="nav-count">{terminals.length}</span> : <span />}
      </button>
      <div className="side-label">SERVEURS</div>
      <div className="server-list">
        {servers.map((server) => {
          const selected = terminalsView === null && server.id === selectedId
          const terminalsSelected = terminalsView?.serverId === server.id
          const terminalCount = terminals.filter((t) => t.serverId === server.id).length
          const open = expanded.has(server.id)
          const Chevron = open ? ChevronDown : ChevronRight
          return (
            <div key={server.id} className="server-group">
              <div className={`server-row${selected || terminalsSelected ? ' selected' : ''}`}>
                <button className="server-toggle" onClick={() => toggle(server.id)} aria-expanded={open} title={open ? 'Replier les sessions' : 'Afficher les sessions'}>
                  <Chevron size={16} />
                </button>
                <button className="server-main" onClick={() => onSelect(server.id)}>
                  <span className={`dot${server.sessions.some((s) => s.shell === 'connected') ? ' on' : ''}`} />
                  <span style={{ minWidth: 0 }}>
                    <div className="server-name">{server.name}</div>
                    <div className="server-sub">{subtitle(server)}</div>
                  </span>
                  {!open && server.pendingCount > 0 ? <span className="badge">{server.pendingCount}</span> : <span />}
                </button>
              </div>
              {open && (
                <div className="session-list">
                  <button className={`session-row${terminalsSelected ? ' selected' : ''}`} onClick={() => onOpenTerminals(server.id)}>
                    <SquareTerminal size={15} className="session-icon" />
                    <span className="session-name">Terminaux</span>
                    {terminalCount > 0 ? <span className="session-count">{terminalCount}</span> : <span />}
                  </button>
                  {server.sessions.map((session) => {
                    const Icon = session.id === null ? User : Bot
                    return (
                      <button
                        key={session.id ?? 'user'}
                        className={`session-row${selected && session.id === selectedSessionId ? ' selected' : ''}`}
                        onClick={() => onSelectSession(server.id, session.id)}
                      >
                        <Icon size={15} className={session.id === null ? 'session-icon' : 'session-icon agent'} />
                        <span className="session-name">{session.name}</span>
                        <SessionState session={session} />
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <ResizeHandle width={width} onResize={onResize} />
      <div className="sidebar-foot">
        <button className="btn btn-secondary btn-block" onClick={onAdd}>
          <Plus size={18} />
          Ajouter un serveur
        </button>
        <button className="btn btn-secondary btn-square" onClick={onSettings} title="Réglages" aria-label="Réglages">
          <Settings size={18} />
        </button>
      </div>
    </aside>
  )
}
