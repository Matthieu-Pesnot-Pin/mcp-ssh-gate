import { useState, type FormEvent } from 'react'
import { ArrowRight, Check, ChevronsLeftRightEllipsis, CircleAlert, CircleX, Copy, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react'
import { isReady, MAX_TUNNEL_NAME_LENGTH, type LocalPortUse, type ServerView, type TunnelInput, type TunnelView, type TunnelsResponse } from '@shared/model'
import { api } from '../api'
import { Modal } from './Modals'

type Layout = 'server' | 'port'

const MIN_PORT = 1
const MAX_PORT = 65535

function remoteAddress(tunnel: Pick<TunnelView, 'remoteHost' | 'remotePort'>): string {
  return `${tunnel.remoteHost}:${tunnel.remotePort}`
}

function isOn(tunnel: TunnelView): boolean {
  return tunnel.status !== 'stopped'
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT
}

/** Interrupteur d'un tunnel : allumé pour un tunnel démarré, en cours d'ouverture ou en échec. */
function Switch({ on, disabled, onToggle, label }: { on: boolean; disabled: boolean; onToggle: () => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} title={label} className={`tn-switch${on ? ' on' : ''}`} disabled={disabled} onClick={onToggle}>
      <span className="tn-knob" />
    </button>
  )
}

function CopyAddress({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button className="icon-btn tn-mini" onClick={() => void copy()} title={`Copier ${value}`}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

interface RowActions {
  busyId: string | null
  confirmDelete: string | null
  onToggle: (tunnel: TunnelView) => void
  onEdit: (tunnel: TunnelView) => void
  onAskDelete: (id: string | null) => void
  onDelete: (tunnel: TunnelView) => void
}

function EditActions({ tunnel, actions }: { tunnel: TunnelView; actions: RowActions }) {
  if (actions.confirmDelete === tunnel.id) {
    return (
      <span className="tn-actions confirm">
        <button className="btn btn-secondary btn-sm" onClick={() => actions.onAskDelete(null)}>
          Annuler
        </button>
        <button className="btn btn-danger btn-sm" onClick={() => actions.onDelete(tunnel)}>
          Supprimer
        </button>
      </span>
    )
  }
  return (
    <span className="tn-actions">
      <button className="icon-btn" title="Modifier" onClick={() => actions.onEdit(tunnel)}>
        <Pencil size={16} />
      </button>
      <button className="icon-btn" title="Supprimer" onClick={() => actions.onAskDelete(tunnel.id)}>
        <Trash2 size={16} />
      </button>
    </span>
  )
}

function TunnelSwitch({ tunnel, actions }: { tunnel: TunnelView; actions: RowActions }) {
  return (
    <Switch
      on={isOn(tunnel)}
      disabled={tunnel.status === 'starting' || actions.busyId === tunnel.id}
      onToggle={() => actions.onToggle(tunnel)}
      label={isOn(tunnel) ? 'Arrêter le tunnel' : 'Démarrer le tunnel'}
    />
  )
}

/** Ligne de la vue par serveur : nom, port de cette machine, adresse jointe depuis le serveur. */
function TunnelRow({ tunnel, actions }: { tunnel: TunnelView; actions: RowActions }) {
  const local = `localhost:${tunnel.localPort}`
  return (
    <div className={`tn-row tn-row-server${tunnel.status === 'stopped' ? ' stopped' : ''}`}>
      <span className={`dot small tn-dot ${tunnel.status}`} />
      <span className={tunnel.name ? 'tn-name' : 'tn-name unnamed mono'}>{tunnel.name || remoteAddress(tunnel)}</span>
      <span className="tn-local">
        <span className={`mono tn-address ${tunnel.status}`}>{local}</span>
        {tunnel.status === 'active' && (
          <>
            <CopyAddress value={local} />
            <a className="icon-btn tn-mini" href={`http://${local}`} target="_blank" rel="noreferrer" title={`Ouvrir http://${local}`}>
              <ExternalLink size={14} />
            </a>
          </>
        )}
      </span>
      <ArrowRight size={14} className="tn-arrow" />
      <span className="mono tn-remote">{remoteAddress(tunnel)}</span>
      <span className="tn-state">
        {tunnel.status === 'starting' && <span className="tn-note">Connexion…</span>}
        {tunnel.status === 'error' && (
          <>
            <span className="tn-error" title={tunnel.error ?? undefined}>
              {tunnel.error}
            </span>
            {tunnel.portTaken && (
              <button className="btn btn-secondary btn-sm" onClick={() => actions.onEdit(tunnel)}>
                Changer de port
              </button>
            )}
          </>
        )}
      </span>
      <EditActions tunnel={tunnel} actions={actions} />
      <TunnelSwitch tunnel={tunnel} actions={actions} />
    </div>
  )
}

function ByServer({ servers, tunnels, scoped, actions }: { servers: ServerView[]; tunnels: TunnelView[]; scoped: boolean; actions: RowActions }) {
  const groups = servers.map((server) => ({ server, tunnels: tunnels.filter((t) => t.serverId === server.id) })).filter((g) => g.tunnels.length > 0)
  return (
    <>
      <div className="tn-row tn-row-server tn-head">
        <span />
        <span>NOM</span>
        <span>SUR CETTE MACHINE</span>
        <span />
        <span>SUR LE SERVEUR</span>
      </div>
      {groups.map(({ server, tunnels: list }) => (
        <section key={server.id} className="tn-group">
          {!scoped && (
            <div className="tn-group-head">
              <span className="tn-group-name">{server.name}</span>
              <span className="tn-group-sub">
                {server.username}@{server.host}
              </span>
            </div>
          )}
          <div className="tn-card">
            {list.map((tunnel) => (
              <TunnelRow key={tunnel.id} tunnel={tunnel} actions={actions} />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

type PortEntry = { port: number; tunnel: TunnelView; use: null } | { port: number; tunnel: null; use: LocalPortUse }

/** Vue par port local : tunnels et ports pris par d'autres applications, triés par numéro. */
function ByPort({ servers, tunnels, localPorts, actions }: { servers: ServerView[]; tunnels: TunnelView[]; localPorts: LocalPortUse[]; actions: RowActions }) {
  const entries: PortEntry[] = [
    ...tunnels.map((tunnel): PortEntry => ({ port: tunnel.localPort, tunnel, use: null })),
    ...localPorts.filter((use) => !tunnels.some((t) => t.localPort === use.port)).map((use): PortEntry => ({ port: use.port, tunnel: null, use })),
  ].sort((a, b) => a.port - b.port)

  return (
    <>
      <div className="tn-row tn-row-port tn-head">
        <span>PORT LOCAL</span>
        <span>TUNNEL</span>
        <span>SERVEUR OU PROGRAMME</span>
        <span>SUR LE SERVEUR</span>
      </div>
      <div className="tn-card">
        {entries.map((entry) =>
          entry.tunnel ? (
            <div key={`t-${entry.tunnel.id}`} className={`tn-row tn-row-port${entry.tunnel.status === 'stopped' ? ' stopped' : ''}`}>
              <span className={`mono tn-port ${entry.tunnel.status}`}>{entry.port}</span>
              <span className={entry.tunnel.name ? 'tn-name' : 'tn-name unnamed'}>{entry.tunnel.name || '—'}</span>
              <span className="tn-server">{servers.find((s) => s.id === entry.tunnel.serverId)?.name ?? entry.tunnel.serverId}</span>
              <span className="mono tn-remote">{remoteAddress(entry.tunnel)}</span>
              <span className="tn-state">
                {entry.tunnel.status === 'stopped' && <span className="tn-note">réservé, arrêté</span>}
                {entry.tunnel.status === 'starting' && <span className="tn-note">Connexion…</span>}
                {entry.tunnel.status === 'error' && (
                  <span className="tn-error" title={entry.tunnel.error ?? undefined}>
                    {entry.tunnel.error}
                  </span>
                )}
              </span>
              <EditActions tunnel={entry.tunnel} actions={actions} />
              <TunnelSwitch tunnel={entry.tunnel} actions={actions} />
            </div>
          ) : (
            <div key={`p-${entry.port}`} className="tn-row tn-row-port other">
              <span className="mono tn-port">{entry.port}</span>
              <span className="tn-name other">Autre application</span>
              <span className="mono tn-server">{entry.use.process ?? ''}</span>
            </div>
          )
        )}
      </div>
      <div className="muted-note">Les ports pris par d'autres applications sont relevés sur cette machine et ne peuvent pas être attribués à un tunnel.</div>
    </>
  )
}

interface ModalProps {
  servers: ServerView[]
  tunnels: TunnelView[]
  localPorts: LocalPortUse[]
  /** Tunnel modifié ; null pour en créer un. */
  initial: TunnelView | null
  defaultServerId: string | null
  onClose: () => void
  onSaved: () => void
}

/** Occupant d'un port local, ou null quand le port est libre pour ce tunnel. */
function occupant(port: number, selfId: string | null, tunnels: TunnelView[], localPorts: LocalPortUse[], servers: ServerView[]): string | null {
  const tunnel = tunnels.find((t) => t.localPort === port && t.id !== selfId)
  if (tunnel) {
    const server = servers.find((s) => s.id === tunnel.serverId)
    return `le tunnel ${tunnel.name || remoteAddress(tunnel)}${server ? ` de ${server.name}` : ''}`
  }
  const use = localPorts.find((p) => p.port === port)
  if (use) return use.process ?? 'une autre application'
  return null
}

/** Deux ports libres : le premier au-dessus du port demandé, et le port distant décalé de 10000. */
function suggestions(wanted: number, remotePort: number, isFree: (port: number) => boolean): number[] {
  const found: number[] = []
  for (let port = wanted + 1; port <= MAX_PORT && found.length === 0; port++) if (isFree(port)) found.push(port)
  const shifted = remotePort + 10000
  if (validPort(shifted) && isFree(shifted) && !found.includes(shifted)) found.push(shifted)
  for (let port = (found[0] ?? wanted) + 1; port <= MAX_PORT && found.length < 2; port++) if (isFree(port) && !found.includes(port)) found.push(port)
  return found.slice(0, 2)
}

function TunnelModal({ servers, tunnels, localPorts, initial, defaultServerId, onClose, onSaved }: ModalProps) {
  const [serverId, setServerId] = useState(initial?.serverId ?? defaultServerId ?? servers.find(isReady)?.id ?? servers[0]?.id ?? '')
  const [remoteHost, setRemoteHost] = useState(initial?.remoteHost ?? 'localhost')
  const [remotePort, setRemotePort] = useState(initial ? String(initial.remotePort) : '')
  const [localPort, setLocalPort] = useState(initial ? String(initial.localPort) : '')
  const [localTouched, setLocalTouched] = useState(initial !== null)
  const [name, setName] = useState(initial?.name ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selfId = initial?.id ?? null
  const local = Number(localPort)
  const remote = Number(remotePort)
  const taken = localPort && validPort(local) ? occupant(local, selfId, tunnels, localPorts, servers) : null
  const isFree = (port: number) => occupant(port, selfId, tunnels, localPorts, servers) === null
  const range = validPort(local) ? { from: Math.floor(local / 1000) * 1000, to: Math.min(Math.floor(local / 1000) * 1000 + 999, MAX_PORT) } : null
  const nearby = range ? localPorts.filter((p) => p.port >= range.from && p.port <= range.to).map((p) => p.port) : []
  const occupied = [...new Set([...tunnels.filter((t) => t.id !== selfId).map((t) => t.localPort), ...nearby])].sort((a, b) => a - b)
  const valid = !!serverId && !!remoteHost.trim() && validPort(remote) && validPort(local) && !taken && name.length <= MAX_TUNNEL_NAME_LENGTH

  function changeRemotePort(value: string) {
    const digits = value.replace(/\D/g, '').slice(0, 5)
    setRemotePort(digits)
    if (!localTouched) setLocalPort(digits)
  }

  function changeLocalPort(value: string) {
    setLocalPort(value.replace(/\D/g, '').slice(0, 5))
    setLocalTouched(true)
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!valid || saving) return
    setSaving(true)
    setError(null)
    const input: TunnelInput = { serverId, name: name.trim(), localPort: local, remoteHost: remoteHost.trim(), remotePort: remote }
    try {
      if (initial) await api.updateTunnel(initial.id, input)
      else await api.createTunnel(input)
      onSaved()
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  function portTitle(port: number): string {
    const tunnel = tunnels.find((t) => t.localPort === port && t.id !== selfId)
    if (tunnel) return `${tunnel.name || remoteAddress(tunnel)} · ${servers.find((s) => s.id === tunnel.serverId)?.name ?? tunnel.serverId}`
    return localPorts.find((p) => p.port === port)?.process ?? 'Autre application'
  }

  return (
    <Modal
      title={initial ? 'Modifier le tunnel' : 'Nouveau tunnel'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={!valid || saving}>
            {saving ? 'Ouverture…' : initial ? 'Enregistrer' : 'Ouvrir le tunnel'}
          </button>
        </>
      }
    >
      <form className="tn-form" onSubmit={(e) => void submit(e)}>
        <label>
          <div className="field-label">Serveur</div>
          <select className="input" value={serverId} onChange={(e) => setServerId(e.target.value)}>
            {servers.map((server) => (
              <option key={server.id} value={server.id} disabled={!isReady(server)}>
                {server.name} — {server.username}@{server.host}
                {isReady(server) ? '' : server.publicKey ? ' (connexion à tester)' : ' (clé révoquée)'}
              </option>
            ))}
          </select>
        </label>

        <div>
          <div className="field-label">Sur le serveur</div>
          <div className="tn-address-fields">
            <input className="input mono" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="localhost" aria-label="Hôte joint depuis le serveur" />
            <span className="tn-colon">:</span>
            <input
              className="input mono tn-port-input"
              autoFocus={!initial}
              inputMode="numeric"
              value={remotePort}
              onChange={(e) => changeRemotePort(e.target.value)}
              placeholder="5432"
              aria-label="Port joint depuis le serveur"
            />
          </div>
        </div>

        <div>
          <div className="field-label">Sur cette machine</div>
          <div className="tn-address-fields">
            <span className="tn-prefix mono">localhost :</span>
            <input
              className={`input mono tn-port-input${taken ? ' invalid' : ''}`}
              autoFocus={!!initial?.portTaken}
              inputMode="numeric"
              value={localPort}
              onChange={(e) => changeLocalPort(e.target.value)}
              aria-label="Port de cette machine"
            />
          </div>
          {taken && (
            <>
              <div className="tn-taken">
                <CircleAlert size={14} />
                Déjà pris par {taken}
              </div>
              <div className="tn-suggest">
                <span>Libres :</span>
                {suggestions(local, validPort(remote) ? remote : local, isFree).map((port) => (
                  <button
                    key={port}
                    type="button"
                    className="tn-suggest-chip mono"
                    onClick={() => {
                      setLocalPort(String(port))
                      setLocalTouched(true)
                    }}
                  >
                    {port}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {occupied.length > 0 && (
          <div>
            <div className="field-label tn-occupied-label">
              Ports déjà occupés : tunnels{range ? `, et autres applications entre ${range.from} et ${range.to}` : ''}
            </div>
            <div className="tn-occupied">
              {occupied.map((port) => (
                <span key={port} className={`tn-occupied-chip mono${port === local ? ' clash' : ''}`} title={portTitle(port)}>
                  {port}
                </span>
              ))}
            </div>
          </div>
        )}

        <label>
          <div className="field-label">Nom (facultatif)</div>
          <input className="input" value={name} maxLength={MAX_TUNNEL_NAME_LENGTH} onChange={(e) => setName(e.target.value)} placeholder="Postgres" />
        </label>
        <button type="submit" hidden />
      </form>
      {error && (
        <div className="result-ko">
          <CircleX size={20} style={{ flexShrink: 0 }} />
          <div>{error}</div>
        </div>
      )}
    </Modal>
  )
}

interface Props {
  servers: ServerView[]
  /** Serveur dont la vue montre les tunnels ; null pour les tunnels de tous les serveurs. */
  server: ServerView | null
  data: TunnelsResponse | null
  loadError: string | null
  onChanged: () => void
  onError: (message: string) => void
}

/**
 * Vue Tunnels : sur tous les serveurs, rangés par serveur ou par port local, ou
 * sur un seul serveur. Chaque tunnel se démarre et s'arrête par son interrupteur.
 */
export function TunnelsScreen({ servers, server, data, loadError, onChanged, onError }: Props) {
  const [layout, setLayout] = useState<Layout>('server')
  const [editing, setEditing] = useState<{ tunnel: TunnelView | null } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const allTunnels = data?.tunnels ?? []
  const tunnels = server ? allTunnels.filter((t) => t.serverId === server.id) : allTunnels
  const activeCount = tunnels.filter((t) => t.status === 'active').length
  const counts = tunnels.length === 0 ? 'Aucun tunnel' : `${activeCount} ${activeCount > 1 ? 'actifs' : 'actif'} sur ${tunnels.length}`
  const sub = server ? `${server.username}@${server.host} · ${counts}` : `${counts} · chaque port n'écoute que sur cette machine (127.0.0.1)`

  async function act(tunnel: TunnelView, action: () => Promise<unknown>) {
    setBusyId(tunnel.id)
    try {
      await action()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusyId(null)
      onChanged()
    }
  }

  const actions: RowActions = {
    busyId,
    confirmDelete,
    onToggle: (tunnel) => void act(tunnel, () => (isOn(tunnel) ? api.stopTunnel(tunnel.id) : api.startTunnel(tunnel.id))),
    onEdit: (tunnel) => setEditing({ tunnel }),
    onAskDelete: setConfirmDelete,
    onDelete: (tunnel) => {
      setConfirmDelete(null)
      void act(tunnel, () => api.deleteTunnel(tunnel.id))
    },
  }

  return (
    <main className="main">
      <header className="topbar">
        <div style={{ minWidth: 0 }}>
          <div className="topbar-title">{server ? `Tunnels · ${server.name}` : 'Tunnels'}</div>
          <div className="topbar-sub">{sub}</div>
        </div>
        <span className="topbar-spacer" />
        <button className="btn btn-primary" onClick={() => setEditing({ tunnel: null })} disabled={!data || servers.length === 0}>
          <Plus size={16} />
          Nouveau tunnel
        </button>
      </header>

      <div className="content tn-content">
        {!data ? (
          <div className="empty">{loadError ?? 'Chargement…'}</div>
        ) : (
          <>
            {!server && (tunnels.length > 0 || data.localPorts.length > 0) && (
              <div className="segmented tn-layout" role="radiogroup" aria-label="Présentation des tunnels">
                <button role="radio" aria-checked={layout === 'server'} className={layout === 'server' ? 'selected' : ''} onClick={() => setLayout('server')}>
                  Par serveur
                </button>
                <button role="radio" aria-checked={layout === 'port'} className={layout === 'port' ? 'selected' : ''} onClick={() => setLayout('port')}>
                  Par port local
                </button>
              </div>
            )}
            {loadError && <div className="tn-error tn-load-error">{loadError}</div>}
            {!server && layout === 'port' ? (
              <ByPort servers={servers} tunnels={tunnels} localPorts={data.localPorts} actions={actions} />
            ) : tunnels.length === 0 ? (
              <div className="empty">
                <ChevronsLeftRightEllipsis size={40} />
                <div className="empty-title">Aucun tunnel</div>
                <p>
                  Un tunnel rend un service {server ? `de ${server.name}` : "d'un serveur"} joignable sur un port de cette machine : une base de données ou une interface web qui
                  n'écoute qu'en local sur le serveur, par exemple. L'agent n'y a pas accès.
                </p>
              </div>
            ) : (
              <ByServer servers={servers} tunnels={tunnels} scoped={server !== null} actions={actions} />
            )}
          </>
        )}
      </div>

      {editing && data && (
        <TunnelModal
          servers={servers}
          tunnels={allTunnels}
          localPorts={data.localPorts}
          initial={editing.tunnel}
          defaultServerId={server?.id ?? null}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      )}
    </main>
  )
}
