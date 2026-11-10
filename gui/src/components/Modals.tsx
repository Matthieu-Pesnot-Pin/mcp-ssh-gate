import { useState, type FormEvent, type ReactNode } from 'react'
import { Check, CircleCheck, CircleX, Copy, Lock, Pencil, Server, X } from 'lucide-react'
import type { ServerView } from '@shared/model'
import { api, type ServerFields } from '../api'

function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="modal-body">
          <div className="modal-head">
            <span className="modal-title">{title}</span>
            <button className="icon-btn" onClick={onClose} title="Fermer">
              <X size={20} />
            </button>
          </div>
          {children}
        </div>
        <div className="modal-foot">{footer}</div>
      </div>
    </div>
  )
}

function CopyButton({ value, label = 'Copier', compact = false }: { value: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  if (compact) {
    return (
      <button className="icon-btn" onClick={() => void copy()} title="Copier">
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    )
  }
  return (
    <button className="small-btn" onClick={() => void copy()}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? 'Copié' : label}
    </button>
  )
}

function ServerForm({ fields, onChange, onSubmit }: { fields: ServerFields; onChange: (f: ServerFields) => void; onSubmit: () => void }) {
  function submit(event: FormEvent) {
    event.preventDefault()
    onSubmit()
  }
  return (
    <form className="form-grid" onSubmit={submit}>
      <label className="wide">
        <div className="field-label">Nom</div>
        <input className="input" autoFocus value={fields.name} onChange={(e) => onChange({ ...fields, name: e.target.value })} placeholder="prod-web" />
      </label>
      <label>
        <div className="field-label">Hôte</div>
        <input className="input" value={fields.host} onChange={(e) => onChange({ ...fields, host: e.target.value })} placeholder="10.0.0.12" />
      </label>
      <label>
        <div className="field-label">Port</div>
        <input className="input" value={String(fields.port)} onChange={(e) => onChange({ ...fields, port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
      </label>
      <label className="wide">
        <div className="field-label">Utilisateur</div>
        <input className="input" value={fields.username} onChange={(e) => onChange({ ...fields, username: e.target.value })} placeholder="deploy" />
      </label>
      <button type="submit" hidden />
    </form>
  )
}

type Step = 'form' | 'key' | 'test'

function Stepper({ step }: { step: Step }) {
  const order: Step[] = ['form', 'key', 'test']
  const labels: Record<Step, string> = { form: 'Serveur', key: 'Clé publique', test: 'Test' }
  const current = order.indexOf(step)
  return (
    <div className="stepper">
      {order.map((item, index) => (
        <span key={item} style={{ display: 'contents' }}>
          {index > 0 && <span className="stepper-line" />}
          <span className={`step${index < current ? ' done' : index === current ? ' active' : ''}`}>
            <span className="step-dot">{index < current ? <Check size={12} strokeWidth={3} /> : index + 1}</span>
            {labels[item]}
          </span>
        </span>
      ))}
    </div>
  )
}

interface ServerModalProps {
  /** Serveur existant (étape clé publique), ou null pour en ajouter un. */
  server: ServerView | null
  onClose: () => void
  onSaved: (server: ServerView) => void
}

/** Ajout d'un serveur en trois étapes : saisie, clé publique à poser, test de connexion. */
export function ServerModal({ server: initial, onClose, onSaved }: ServerModalProps) {
  const [server, setServer] = useState<ServerView | null>(initial)
  const [step, setStep] = useState<Step>(initial ? 'key' : 'form')
  const [fields, setFields] = useState<ServerFields>(
    initial ? { name: initial.name, host: initial.host, port: initial.port, username: initial.username } : { name: '', host: '', port: 22, username: '' }
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ fingerprint: string; cwd: string } | null>(null)

  async function saveFields() {
    setBusy(true)
    setError(null)
    try {
      const saved = server ? await api.updateServer(server.id, fields) : await api.addServer(fields)
      setServer(saved)
      onSaved(saved)
      setStep('key')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    if (!server) return
    setBusy(true)
    setError(null)
    setResult(null)
    setStep('test')
    try {
      const outcome = await api.testConnection(server.id)
      setServer(outcome.server)
      onSaved(outcome.server)
      setResult({ fingerprint: outcome.fingerprint, cwd: outcome.cwd })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const oneLiner = server ? `echo "${server.publicKey}" >> ~/.ssh/authorized_keys` : ''

  let body: ReactNode
  let footer: ReactNode

  if (step === 'form') {
    body = <ServerForm fields={fields} onChange={setFields} onSubmit={() => void saveFields()} />
    footer = (
      <>
        <button className="btn btn-secondary" onClick={server ? () => setStep('key') : onClose}>
          {server ? 'Retour' : 'Annuler'}
        </button>
        <button className="btn btn-primary" onClick={() => void saveFields()} disabled={busy}>
          {server ? 'Enregistrer' : 'Générer la clé'}
        </button>
      </>
    )
  } else if (step === 'key' && server) {
    body = (
      <>
        <div className="summary">
          <Server size={20} />
          <span>
            {server.name} · {server.username}@{server.host}:{server.port}
          </span>
          <button className="icon-btn" title="Modifier" onClick={() => setStep('form')}>
            <Pencil size={18} />
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="section-title">
            Clé publique à ajouter sur le serveur
            <CopyButton value={server.publicKey} />
          </div>
          <div className="keybox">{server.publicKey}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="muted-line">Ou en une commande, connecté au serveur en tant que {server.username} :</div>
          <div className="oneliner">
            <span>{oneLiner}</span>
            <CopyButton value={oneLiner} compact />
          </div>
        </div>
        <div className="muted-line">
          <Lock size={16} />
          La clé privée reste chiffrée dans le MCP. Elle n'est jamais affichée.
        </div>
      </>
    )
    footer = (
      <>
        <button className="btn btn-secondary" onClick={onClose}>
          Plus tard
        </button>
        <button className="btn btn-primary" onClick={() => void test()} disabled={busy}>
          Tester la connexion
        </button>
      </>
    )
  } else {
    body = busy ? (
      <div className="muted-line">Connexion à {server?.host}…</div>
    ) : result ? (
      <div className="result-ok">
        <CircleCheck size={20} style={{ flexShrink: 0 }} />
        <div>
          Connexion réussie, shell ouvert dans {result.cwd}.
          <br />
          Empreinte du serveur enregistrée : <span className="mono">{result.fingerprint}</span>
          <br />
          L'agent peut maintenant soumettre des commandes sur ce serveur.
        </div>
      </div>
    ) : (
      <div className="result-ko">
        <CircleX size={20} style={{ flexShrink: 0 }} />
        <div>{error}</div>
      </div>
    )
    footer = result ? (
      <button className="btn btn-primary" onClick={onClose}>
        Terminer
      </button>
    ) : (
      <>
        <button className="btn btn-secondary" onClick={() => setStep('key')} disabled={busy}>
          Retour à la clé
        </button>
        <button className="btn btn-primary" onClick={() => void test()} disabled={busy}>
          Réessayer
        </button>
      </>
    )
  }

  return (
    <Modal title={initial ? `Clé publique — ${initial.name}` : 'Ajouter un serveur'} onClose={onClose} footer={footer}>
      <Stepper step={step} />
      {body}
      {error && step === 'form' && (
        <div className="result-ko">
          <CircleX size={20} style={{ flexShrink: 0 }} />
          <div>{error}</div>
        </div>
      )}
    </Modal>
  )
}

interface EditModalProps {
  server: ServerView
  onClose: () => void
  onSaved: (server: ServerView) => void
}

/** Modification du nom, de l'hôte, du port ou de l'utilisateur ; la paire de clés est conservée. */
export function EditServerModal({ server, onClose, onSaved }: EditModalProps) {
  const [fields, setFields] = useState<ServerFields>({ name: server.name, host: server.host, port: server.port, username: server.username })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.updateServer(server.id, fields))
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const hostChanged = fields.host.trim() !== server.host || Number(fields.port) !== server.port

  return (
    <Modal
      title={`Modifier ${server.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>
            Enregistrer
          </button>
        </>
      }
    >
      <ServerForm fields={fields} onChange={setFields} onSubmit={() => void save()} />
      {hostChanged && server.hostKeyFingerprint && (
        <div className="muted-line">Changer d'hôte ou de port efface l'empreinte enregistrée : il faudra tester la connexion à nouveau.</div>
      )}
      {error && (
        <div className="result-ko">
          <CircleX size={20} style={{ flexShrink: 0 }} />
          <div>{error}</div>
        </div>
      )}
    </Modal>
  )
}

interface ConfirmDeleteProps {
  server: ServerView
  onClose: () => void
  onDeleted: () => void
}

export function ConfirmDeleteModal({ server, onClose, onDeleted }: ConfirmDeleteProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    try {
      await api.deleteServer(server.id)
      onDeleted()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Supprimer ${server.name} ?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-danger" onClick={() => void remove()} disabled={busy}>
            Supprimer
          </button>
        </>
      }
    >
      <p className="explanation">
        La paire de clés et l'historique des commandes de ce serveur seront effacés. Pense à retirer la clé publique du fichier ~/.ssh/authorized_keys de{' '}
        {server.username} sur {server.host}.
      </p>
      {error && (
        <div className="result-ko">
          <CircleX size={20} style={{ flexShrink: 0 }} />
          <div>{error}</div>
        </div>
      )}
    </Modal>
  )
}
