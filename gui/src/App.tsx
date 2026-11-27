import { useEffect, useRef, useState } from 'react'
import { CircleX, Server, X } from 'lucide-react'
import { DEFAULT_LINE_BREAK_MODE, type ServerView } from '@shared/model'
import { LineBreakContext } from './components/CommandText'
import { api } from './api'
import { usePolling } from './usePolling'
import { readLastViews, useSidebarWidth, writeLastViews, type LastView } from './prefs'
import { Sidebar } from './components/Sidebar'
import { ServerScreen } from './components/ServerScreen'
import { TerminalsScreen } from './components/TerminalsScreen'
import { TunnelsScreen } from './components/TunnelsScreen'
import { WhitelistScreen, type WhitelistScope } from './components/Whitelist'
import { ConfirmDeleteModal, EditServerModal, RevokeKeyModal, RotateKeyModal, ServerModal, SettingsModal } from './components/Modals'

type Dialog = { kind: 'add' | 'settings' } | { kind: 'key' | 'edit' | 'delete' | 'rotate' | 'revoke'; server: ServerView } | null

const TERMINALS_HASH = '#terminaux'

interface TerminalsView {
  /** Serveur dont on montre les terminaux ; null pour tous les serveurs. */
  serverId: string | null
}

/** Adresse de la vue Terminaux : `#terminaux` pour tous les serveurs, `#terminaux/<serveur>` pour un seul. */
function terminalsFromHash(): TerminalsView | null {
  const match = /^#terminaux(?:\/([^/]+))?$/.exec(window.location.hash)
  return match ? { serverId: match[1] ? decodeURIComponent(match[1]) : null } : null
}

function terminalsHash(serverId: string | null): string {
  return serverId ? `${TERMINALS_HASH}/${encodeURIComponent(serverId)}` : TERMINALS_HASH
}

const TUNNELS_HASH = '#tunnels'

/** Adresse de la vue Tunnels : `#tunnels` pour tous les serveurs, `#tunnels/<serveur>` pour un seul. */
function tunnelsFromHash(): TerminalsView | null {
  const match = /^#tunnels(?:\/([^/]+))?$/.exec(window.location.hash)
  return match ? { serverId: match[1] ? decodeURIComponent(match[1]) : null } : null
}

function tunnelsHash(serverId: string | null): string {
  return serverId ? `${TUNNELS_HASH}/${encodeURIComponent(serverId)}` : TUNNELS_HASH
}

const WHITELIST_HASH = '#liste-blanche'

/** Adresse de la liste blanche : `#liste-blanche` pour la liste commune, `#liste-blanche/<serveur>` pour celle d'un serveur. */
function whitelistFromHash(): { scope: WhitelistScope } | null {
  const match = /^#liste-blanche(?:\/([^/]+))?$/.exec(window.location.hash)
  return match ? { scope: match[1] ? decodeURIComponent(match[1]) : null } : null
}

function whitelistHash(scope: WhitelistScope): string {
  return scope === null ? WHITELIST_HASH : `${WHITELIST_HASH}/${encodeURIComponent(scope)}`
}

interface Selection {
  serverId: string
  /** Session d'agent ; null pour la session « Vous ». */
  sessionId: string | null
}

/** Adresse d'une session : `#/<serveur>` pour la session « Vous », `#/<serveur>/<session>` pour une session d'agent. */
function selectionFromHash(): Selection | null {
  const match = /^#\/([^/]+)(?:\/([^/]+))?$/.exec(window.location.hash)
  return match ? { serverId: decodeURIComponent(match[1]), sessionId: match[2] ? decodeURIComponent(match[2]) : null } : null
}

function sessionHash(serverId: string, sessionId: string | null): string {
  return `#/${encodeURIComponent(serverId)}${sessionId ? `/${encodeURIComponent(sessionId)}` : ''}`
}

/**
 * Session ouverte quand aucun onglet n'a été choisi dans le serveur : celle qui a une
 * demande en attente, sinon la session d'agent ouverte le plus récemment, sinon « Vous ».
 */
function defaultSessionId(server: ServerView): string | null {
  const pending = server.sessions.find((s) => s.pendingCount > 0)
  if (pending) return pending.id
  const agents = server.sessions.filter((s) => s.id !== null)
  return agents.length ? agents[agents.length - 1].id : null
}

export default function App() {
  const state = usePolling('state', api.state, 2000)
  const terminals = usePolling('terminals', api.terminals, 2500)
  const tunnels = usePolling('tunnels', api.tunnels, 3000)
  const [selection, setSelection] = useState<Selection | null>(selectionFromHash)
  const [terminalsView, setTerminalsView] = useState<TerminalsView | null>(terminalsFromHash)
  const [tunnelsView, setTunnelsView] = useState<TerminalsView | null>(tunnelsFromHash)
  const [whitelistView, setWhitelistView] = useState<{ scope: WhitelistScope } | null>(whitelistFromHash)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth()
  const lastViews = useRef<Record<string, LastView>>(readLastViews())

  useEffect(() => {
    const onHash = () => {
      setSelection(selectionFromHash())
      setTerminalsView(terminalsFromHash())
      setTunnelsView(tunnelsFromHash())
      setWhitelistView(whitelistFromHash())
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const settings = state.data?.settings
  const palette = settings?.palette
  useEffect(() => {
    if (palette) document.documentElement.dataset.palette = palette
  }, [palette])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  const servers = state.data?.servers ?? []
  const terminalList = terminals.data?.terminals ?? []
  const firstPending = servers.find((s) => s.pendingCount > 0)
  const selected = servers.find((s) => s.id === selection?.serverId) ?? firstPending ?? servers[0] ?? null
  const wantedSessionId = selected && selected.id === selection?.serverId ? selection.sessionId : selected ? defaultSessionId(selected) : null
  const selectedSession = [...(selected?.sessions ?? []), ...(selected?.closedSessions ?? [])].find((s) => s.id === wantedSessionId) ?? null
  const sessionGone = !!selected && !!wantedSessionId && !selectedSession
  const terminalsServer = terminalsView?.serverId ? servers.find((s) => s.id === terminalsView.serverId) ?? null : null
  const terminalsServerGone = !!state.data && !!terminalsView?.serverId && !terminalsServer
  const tunnelsServer = tunnelsView?.serverId ? servers.find((s) => s.id === tunnelsView.serverId) ?? null : null
  const tunnelsServerGone = !!state.data && !!tunnelsView?.serverId && !tunnelsServer

  useEffect(() => {
    if (sessionGone && selected) window.location.hash = sessionHash(selected.id, null)
  }, [sessionGone, selected])

  useEffect(() => {
    if (terminalsServerGone) window.location.hash = TERMINALS_HASH
  }, [terminalsServerGone])

  useEffect(() => {
    if (tunnelsServerGone) window.location.hash = TUNNELS_HASH
  }, [tunnelsServerGone])

  const visitedServerId = terminalsView ? terminalsView.serverId : tunnelsView ? tunnelsView.serverId : selection?.serverId ?? null
  const visitedSessionId = terminalsView || tunnelsView ? null : selection?.sessionId ?? null
  useEffect(() => {
    if (!visitedServerId) return
    const view: LastView = terminalsView ? { kind: 'terminals' } : tunnelsView ? { kind: 'tunnels' } : { kind: 'session', sessionId: visitedSessionId }
    lastViews.current = { ...lastViews.current, [visitedServerId]: view }
    writeLastViews(lastViews.current)
  }, [visitedServerId, visitedSessionId, terminalsView, tunnelsView])

  /**
   * Clic sur un serveur : une session qui a une demande en attente (le dernier onglet
   * ouvert s'il en fait partie) ; sinon le dernier onglet ouvert ; sinon la session
   * d'agent la plus récente, puis la session « Vous ».
   */
  function openServer(id: string) {
    const server = servers.find((s) => s.id === id)
    const last = lastViews.current[id]
    const pending = server?.sessions.filter((s) => s.pendingCount > 0) ?? []
    if (pending.length > 0) {
      const lastPending = last?.kind === 'session' ? pending.find((s) => s.id === last.sessionId) : undefined
      select(id, (lastPending ?? pending[0]).id)
      return
    }
    if (last?.kind === 'terminals') {
      window.location.hash = terminalsHash(id)
      return
    }
    if (last?.kind === 'tunnels') {
      window.location.hash = tunnelsHash(id)
      return
    }
    if (last && (server?.sessions.some((s) => s.id === last.sessionId) || server?.closedSessions.some((s) => s.id === last.sessionId))) {
      select(id, last.sessionId)
      return
    }
    select(id, server ? defaultSessionId(server) : null)
  }

  function select(id: string, sessionId: string | null = null) {
    window.location.hash = sessionHash(id, sessionId)
  }

  function onSaved(server: ServerView) {
    state.reload()
    select(server.id)
  }

  async function installKey(server: ServerView) {
    try {
      const updated = await api.newKey(server.id)
      onSaved(updated)
      setDialog({ kind: 'key', server: updated })
    } catch (err) {
      setNotice((err as Error).message)
    }
  }

  return (
    <LineBreakContext.Provider value={settings?.lineBreaks ?? DEFAULT_LINE_BREAK_MODE}>
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}>
      <Sidebar
        width={sidebarWidth}
        onResize={setSidebarWidth}
        servers={servers}
        selectedId={whitelistView ? null : terminalsView ? terminalsView.serverId : tunnelsView ? tunnelsView.serverId : selected?.id ?? null}
        selectedSessionId={selectedSession?.id ?? null}
        onSelectSession={select}
        terminalsView={terminalsView}
        tunnelsView={tunnelsView}
        tunnels={tunnels.data?.tunnels ?? []}
        onOpenTunnels={(serverId) => (window.location.hash = tunnelsHash(serverId))}
        whitelistOpen={!!whitelistView}
        onOpenWhitelist={() => (window.location.hash = WHITELIST_HASH)}
        terminals={terminalList}
        onSelect={openServer}
        onOpenTerminals={(serverId) => (window.location.hash = terminalsHash(serverId))}
        onAdd={() => setDialog({ kind: 'add' })}
        onSettings={() => setDialog({ kind: 'settings' })}
      />

      {whitelistView ? (
        <WhitelistScreen
          servers={servers}
          scope={whitelistView.scope !== null && state.data && !servers.some((s) => s.id === whitelistView.scope) ? null : whitelistView.scope}
          onScope={(scope) => (window.location.hash = whitelistHash(scope))}
          onError={setNotice}
        />
      ) : tunnelsView ? (
        <TunnelsScreen
          servers={servers}
          server={tunnelsServer}
          data={tunnels.data}
          loadError={tunnels.error}
          onChanged={tunnels.reload}
          onError={setNotice}
        />
      ) : terminalsView ? (
        <TerminalsScreen
          key={terminalsView.serverId ?? ''}
          servers={servers}
          server={terminalsServer}
          terminals={terminalList}
          onChanged={terminals.reload}
          onError={setNotice}
        />
      ) : selected ? (
        <ServerScreen
          key={selected.id}
          server={selected}
          session={selectedSession ?? selected.sessions[0]}
          onChanged={state.reload}
          onError={setNotice}
          onShowKey={() => setDialog({ kind: 'key', server: selected })}
          onInstallKey={() => void installKey(selected)}
          onRotate={() => setDialog({ kind: 'rotate', server: selected })}
          onRevoke={() => setDialog({ kind: 'revoke', server: selected })}
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

      {dialog?.kind === 'settings' && settings && (
        <SettingsModal settings={settings} onClose={() => setDialog(null)} onChanged={state.reload} onError={setNotice} />
      )}
      {dialog?.kind === 'add' && <ServerModal server={null} onClose={() => setDialog(null)} onSaved={onSaved} />}
      {dialog?.kind === 'key' && <ServerModal server={dialog.server} onClose={() => setDialog(null)} onSaved={onSaved} />}
      {dialog?.kind === 'rotate' && <RotateKeyModal server={dialog.server} onClose={() => setDialog(null)} onSaved={onSaved} />}
      {dialog?.kind === 'revoke' && (
        <RevokeKeyModal
          server={dialog.server}
          terminalCount={terminalList.filter((t) => t.serverId === dialog.server.id && t.status === 'open').length}
          onClose={() => setDialog(null)}
          onSaved={(server) => {
            onSaved(server)
            terminals.reload()
            tunnels.reload()
          }}
        />
      )}
      {dialog?.kind === 'edit' && <EditServerModal server={dialog.server} onClose={() => setDialog(null)} onSaved={onSaved} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDeleteModal
          server={dialog.server}
          onClose={() => setDialog(null)}
          onDeleted={() => {
            setDialog(null)
            window.location.hash = ''
            state.reload()
            tunnels.reload()
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
    </LineBreakContext.Provider>
  )
}
