import { useEffect, useState } from 'react'
import { CircleX, Server, X } from 'lucide-react'
import type { ServerView } from '@shared/model'
import { api } from './api'
import { usePolling } from './usePolling'
import { Sidebar } from './components/Sidebar'
import { ServerScreen } from './components/ServerScreen'
import { TerminalsScreen } from './components/TerminalsScreen'
import { ConfirmDeleteModal, EditServerModal, ServerModal } from './components/Modals'

type Dialog = { kind: 'add' } | { kind: 'key'; server: ServerView } | { kind: 'edit'; server: ServerView } | { kind: 'delete'; server: ServerView } | null

const TERMINALS_HASH = '#terminaux'

function selectedFromHash(): string | null {
  const match = /^#\/([^/]+)$/.exec(window.location.hash)
  return match ? decodeURIComponent(match[1]) : null
}

export default function App() {
  const state = usePolling('state', api.state, 2000)
  const terminals = usePolling('terminals', api.terminals, 2500)
  const [selectedId, setSelectedId] = useState<string | null>(selectedFromHash)
  const [terminalsOpen, setTerminalsOpen] = useState(window.location.hash === TERMINALS_HASH)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const onHash = () => {
      setSelectedId(selectedFromHash())
      setTerminalsOpen(window.location.hash === TERMINALS_HASH)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  const servers = state.data?.servers ?? []
  const terminalList = terminals.data?.terminals ?? []
  const firstPending = servers.find((s) => s.pendingCount > 0)
  const selected = servers.find((s) => s.id === selectedId) ?? firstPending ?? servers[0] ?? null

  function select(id: string) {
    window.location.hash = `#/${encodeURIComponent(id)}`
  }

  function onSaved(server: ServerView) {
    state.reload()
    select(server.id)
  }

  return (
    <div className="app">
      <Sidebar
        servers={servers}
        selectedId={selected?.id ?? null}
        terminalsOpen={terminalsOpen}
        terminalCount={terminalList.length}
        onSelect={select}
        onOpenTerminals={() => (window.location.hash = TERMINALS_HASH)}
        onAdd={() => setDialog({ kind: 'add' })}
      />

      {terminalsOpen ? (
        <TerminalsScreen servers={servers} terminals={terminalList} onChanged={terminals.reload} onError={setNotice} />
      ) : selected ? (
        <ServerScreen
          key={selected.id}
          server={selected}
          onChanged={state.reload}
          onError={setNotice}
          onShowKey={() => setDialog({ kind: 'key', server: selected })}
          onEdit={() => setDialog({ kind: 'edit', server: selected })}
          onDelete={() => setDialog({ kind: 'delete', server: selected })}
        />
      ) : (
        <main className="main">
          {state.data && (
            <div className="empty">
              <Server size={40} />
              <div className="empty-title">Aucun serveur</div>
              <p>Ajoute un serveur : SSH Gate génère sa paire de clés, tu poses la clé publique sur le serveur, et l'agent peut ensuite y proposer des commandes que tu valides ici.</p>
              <button className="btn btn-primary" onClick={() => setDialog({ kind: 'add' })}>
                Ajouter un serveur
              </button>
            </div>
          )}
          {state.error && !state.data && <div className="empty">{state.error}</div>}
        </main>
      )}

      {dialog?.kind === 'add' && <ServerModal server={null} onClose={() => setDialog(null)} onSaved={onSaved} />}
      {dialog?.kind === 'key' && <ServerModal server={dialog.server} onClose={() => setDialog(null)} onSaved={onSaved} />}
      {dialog?.kind === 'edit' && <EditServerModal server={dialog.server} onClose={() => setDialog(null)} onSaved={onSaved} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDeleteModal
          server={dialog.server}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null)
            window.location.hash = ''
            state.reload()
          }}
        />
      )}

      {notice && (
        <div className="toast" role="alert">
          <CircleX size={18} />
          <span>{notice}</span>
          <button className="icon-btn" onClick={() => setNotice(null)} title="Fermer">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  )
}
