import { useState } from 'react'
import { Bot, ChevronDown, ChevronRight, LoaderCircle, Plus, Settings, SquareTerminal, Terminal, User } from 'lucide-react'
import type { ServerView, SessionView, TerminalView } from '@shared/model'

interface Props {
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

/**
 * Barre latérale : les terminaux de tous les serveurs, puis les serveurs. Sous chaque
 * serveur : ses terminaux, ta session, puis celles des agents.
 */
export function Sidebar({ servers, selectedId, selectedSessionId, terminalsView, terminals, onSelect, onSelectSession, onOpenTerminals, onAdd, onSettings }: Props) {
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())

  function toggle(id: string) {
    const next = new Set(toggled)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setToggled(next)
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
          const open = (server.id === selectedId) !== toggled.has(server.id)
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
