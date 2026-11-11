import { useEffect, useRef, useState } from 'react'
import { EyeOff, Plus, Power, SquareTerminal, X } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { isReady, type ServerView, type TerminalClientMessage, type TerminalServerMessage, type TerminalView } from '@shared/model'
import { api, terminalStreamUrl } from '../api'
import { clock, plural } from '../format'

const TERMINAL_THEME = {
  background: '#07080c',
  foreground: '#c9cedb',
  cursor: '#c9cedb',
  cursorAccent: '#07080c',
  selectionBackground: '#2a3150',
  black: '#1c2029',
  red: '#f0857d',
  green: '#4ade80',
  yellow: '#e3a33b',
  blue: '#8b97ff',
  magenta: '#c792ea',
  cyan: '#5ccfe6',
  white: '#c9cedb',
  brightBlack: '#646b7b',
  brightRed: '#ff9e96',
  brightGreen: '#6ee7a0',
  brightYellow: '#f5c060',
  brightBlue: '#a5afff',
  brightMagenta: '#dcb0f5',
  brightCyan: '#8ae0f0',
  brightWhite: '#eceef3',
}

function label(terminal: TerminalView): string {
  return terminal.number > 1 ? `${terminal.serverName} · ${terminal.number}` : terminal.serverName
}

/** Un terminal : xterm.js relié au shell distant par la WebSocket du worker. */
function TerminalPane({ terminal, active }: { terminal: TerminalView; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    const host = hostRef.current!
    const xterm = new Terminal({
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: TERMINAL_THEME,
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(host)
    xtermRef.current = xterm
    fitRef.current = fit

    let socket: WebSocket | null = null
    let disposed = false
    let ended = false
    const send = (message: TerminalClientMessage) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    }
    const notice = (text: string) => xterm.write(`\r\n\x1b[90m[${text}]\x1b[0m\r\n`)

    api
      .terminalTicket(terminal.id)
      .then(({ ticket }) => {
        if (disposed) return
        socket = new WebSocket(terminalStreamUrl(terminal.id, ticket))
        socketRef.current = socket
        socket.onopen = () => {
          if (host.offsetParent !== null) fit.fit()
          send({ type: 'resize', cols: xterm.cols, rows: xterm.rows })
        }
        socket.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as TerminalServerMessage
          if (message.type === 'output') {
            xterm.write(message.data)
          } else {
            ended = true
            notice(message.reason)
          }
        }
        socket.onclose = (event) => {
          if (!ended) notice(`Liaison avec le terminal perdue${event.reason ? ` : ${event.reason}` : ''}`)
        }
      })
      .catch((err: Error) => {
        if (!disposed) notice(`Liaison avec le terminal impossible : ${err.message}`)
      })

    const input = xterm.onData((data) => send({ type: 'input', data }))
    const resize = xterm.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
    const observer = new ResizeObserver(() => {
      if (host.offsetParent !== null) fit.fit()
    })
    observer.observe(host)

    return () => {
      observer.disconnect()
      input.dispose()
      resize.dispose()
      disposed = true
      if (socket) {
        socket.onclose = null
        socket.close()
      }
      xterm.dispose()
    }
  }, [terminal.id])

  useEffect(() => {
    if (!active) return
    fitRef.current?.fit()
    xtermRef.current?.focus()
  }, [active])

  return <div className="xterm-host" ref={hostRef} style={active ? undefined : { display: 'none' }} />
}

function NewTerminalMenu({ servers, terminals, onOpen }: { servers: ServerView[]; terminals: TerminalView[]; onOpen: (server: ServerView) => void }) {
  return (
    <div className="menu term-picker">
      <div className="menu-label">OUVRIR UN TERMINAL SUR</div>
      {servers.map((server) => {
        const open = terminals.filter((t) => t.serverId === server.id && t.status === 'open').length
        const tested = isReady(server)
        return (
          <button key={server.id} className="picker-row" disabled={!tested} onClick={() => onOpen(server)}>
            <span className={`dot${tested ? ' on' : ''}`} />
            <span style={{ minWidth: 0 }}>
              <div className="server-name">{server.name}</div>
              <div className="server-sub">
                {tested ? `${server.username}@${server.host}${open ? ` · ${plural(open, 'ouvert')}` : ''}` : server.publicKey ? "teste d'abord la connexion" : 'clé révoquée'}
              </div>
            </span>
          </button>
        )
      })}
      {servers.length === 0 && <div className="picker-empty">Aucun serveur.</div>}
    </div>
  )
}

interface Props {
  servers: ServerView[]
  terminals: TerminalView[]
  onChanged: () => void
  onError: (message: string) => void
}

/** Vue Terminaux : un onglet par session interactive, sur n'importe quel serveur. */
export function TerminalsScreen({ servers, terminals, onChanged, onError }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [opening, setOpening] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  const active = terminals.find((t) => t.id === activeId) ?? terminals[0] ?? null
  const activeServer = active ? servers.find((s) => s.id === active.serverId) ?? null : null
  const openCount = terminals.filter((t) => t.status === 'open').length

  useEffect(() => {
    if (!picking) return
    const close = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPicking(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [picking])

  async function open(server: ServerView) {
    setPicking(false)
    setOpening(true)
    try {
      const terminal = await api.openTerminal(server.id, 80, 24)
      setActiveId(terminal.id)
      onChanged()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setOpening(false)
    }
  }

  async function close(terminal: TerminalView) {
    try {
      await api.closeTerminal(terminal.id)
      if (terminal.id === active?.id) {
        const index = terminals.findIndex((t) => t.id === terminal.id)
        setActiveId(terminals[index + 1]?.id ?? terminals[index - 1]?.id ?? null)
      }
      onChanged()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const picker = (
    <div className="menu-anchor" ref={pickerRef}>
      <button className="btn btn-secondary" onClick={() => setPicking(!picking)} disabled={opening}>
        <Plus size={16} />
        {opening ? 'Connexion…' : 'Nouveau terminal'}
      </button>
      {picking && <NewTerminalMenu servers={servers} terminals={terminals} onOpen={(server) => void open(server)} />}
    </div>
  )

  return (
    <main className="main">
      <header className="topbar">
        <div style={{ minWidth: 0 }}>
          <div className="topbar-title">Terminaux</div>
          <div className="topbar-sub">
            {openCount > 0 ? `${plural(openCount, 'session ouverte', 'sessions ouvertes')} · elles restent actives si tu fermes la page` : 'Aucune session ouverte'}
          </div>
        </div>
        <span className="topbar-spacer" />
        {picker}
      </header>

      {terminals.length === 0 ? (
        <div className="empty">
          <SquareTerminal size={40} />
          <div className="empty-title">Aucun terminal ouvert</div>
          <p>Ouvre un terminal sur l'un de tes serveurs. Il reste actif si tu fermes la page, et l'agent n'y a pas accès.</p>
        </div>
      ) : (
        <>
          <div className="term-tabs" role="tablist">
            {terminals.map((terminal) => (
              <div key={terminal.id} role="tab" aria-selected={terminal.id === active?.id} className={`term-tab${terminal.id === active?.id ? ' active' : ''}`}>
                <button className="term-tab-label" onClick={() => setActiveId(terminal.id)} title={label(terminal)}>
                  <span className={`dot small${terminal.status === 'open' ? ' on' : ''}`} />
                  {label(terminal)}
                </button>
                <button className="term-tab-close" title="Fermer la session" onClick={() => void close(terminal)}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <button className="icon-btn term-tab-add" title="Nouveau terminal" onClick={() => setPicking(true)} disabled={opening}>
              <Plus size={18} />
            </button>
          </div>

          <div className="term-body">
            {terminals.map((terminal) => (
              <TerminalPane key={terminal.id} terminal={terminal} active={terminal.id === active?.id} />
            ))}
          </div>

          {active && (
            <footer className="term-status">
              <span className={`dot small${active.status === 'open' ? ' on' : ''}`} />
              <span className="term-status-main">
                {active.status === 'open'
                  ? `${activeServer ? `${activeServer.username}@${activeServer.host}` : active.serverName} · ouvert à ${clock(active.openedAt)} · ${active.cols} × ${active.rows}`
                  : active.closedReason}
              </span>
              <span className="term-status-note">
                <EyeOff size={14} />
                L'agent ne voit pas ce terminal
              </span>
              <button className="term-status-close" onClick={() => void close(active)}>
                <Power size={14} />
                Fermer la session
              </button>
            </footer>
          )}
        </>
      )}
    </main>
  )
}
