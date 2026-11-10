import { Plus, SquareTerminal, Terminal } from 'lucide-react'
import type { ServerView } from '@shared/model'

interface Props {
  servers: ServerView[]
  selectedId: string | null
  terminalsOpen: boolean
  terminalCount: number
  onSelect: (id: string) => void
  onOpenTerminals: () => void
  onAdd: () => void
}

function subtitle(server: ServerView): string {
  if (!server.hostKeyFingerprint) return 'connexion à tester'
  if (server.session === 'closed') return 'shell fermé'
  return `${server.username}@${server.host}`
}

export function Sidebar({ servers, selectedId, terminalsOpen, terminalCount, onSelect, onOpenTerminals, onAdd }: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <Terminal size={22} />
        SSH Gate
      </div>
      <button className={`nav-row${terminalsOpen ? ' selected' : ''}`} onClick={onOpenTerminals}>
        <SquareTerminal size={20} />
        <span>Terminaux</span>
        {terminalCount > 0 ? <span className="nav-count">{terminalCount}</span> : <span />}
      </button>
      <div className="side-label">SERVEURS</div>
      <div className="server-list">
        {servers.map((server) => (
          <button
            key={server.id}
            className={`server-row${!terminalsOpen && server.id === selectedId ? ' selected' : ''}`}
            onClick={() => onSelect(server.id)}
          >
            <span className={`dot${server.session === 'connected' ? ' on' : ''}`} />
            <span style={{ minWidth: 0 }}>
              <div className="server-name">{server.name}</div>
              <div className="server-sub">{subtitle(server)}</div>
            </span>
            {server.pendingCount > 0 ? <span className="badge">{server.pendingCount}</span> : <span />}
          </button>
        ))}
      </div>
      <button className="btn btn-secondary btn-block" onClick={onAdd}>
        <Plus size={18} />
        Ajouter un serveur
      </button>
    </aside>
  )
}
