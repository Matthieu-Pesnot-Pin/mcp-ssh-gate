import { useState, type FormEvent, type ReactNode } from 'react'
import { Ban, Check, CircleCheck, CircleX, Copy, FileKey, Info, KeyRound, Lock, Pencil, RefreshCw, Server, Settings, ShieldCheck, Trash2, TriangleAlert, X } from 'lucide-react'
import type { HighlightPalette, KeyFileStatus, RotationResponse, ServerView } from '@shared/model'
import { CommandText } from './CommandText'
import { DEDICATED_KEY_FILE, REVOKE_COMMAND, installCommand } from '@shared/install'
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
  const labels: Record<Step, string> = { form: 'Serveur', key: 'Installation', test: 'Test' }
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

function CheckRow({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className="check-row">
      {ok ? <CircleCheck size={20} className="check-ok" /> : <TriangleAlert size={20} className="check-warn" />}
      <div>
        <div className="check-title">{title}</div>
        <div className="check-detail">{detail}</div>
      </div>
    </div>
  )
}

function TestResult({ fingerprint, cwd, keyFile }: { fingerprint: string; cwd: string; keyFile: KeyFileStatus }) {
  return (
    <>
      <div className="check-list">
        <CheckRow ok title="Connexion établie" detail={`empreinte du serveur ${fingerprint} enregistrée · shell ouvert dans ${cwd}`} />
        {keyFile.inDedicatedFile &&
          (keyFile.allowedFrom && !keyFile.restrictError ? (
            <CheckRow ok title="Clé limitée à l'adresse de SSH Gate" detail={`from="${keyFile.allowedFrom}" sur sa ligne : l'adresse vue par le serveur pendant le test`} />
          ) : (
            <CheckRow ok={false} title="Clé non limitée à une adresse" detail={keyFile.restrictError ?? "Aucune limite d'adresse sur sa ligne."} />
          ))}
        {keyFile.inDedicatedFile ? (
          <CheckRow ok title="Fichier dédié en place" detail={`~/${DEDICATED_KEY_FILE} · ton authorized_keys n'a pas été touché`} />
        ) : (
          <CheckRow
            ok={false}
            title="Clé hors du fichier dédié"
            detail={`Elle n'est pas dans ~/${DEDICATED_KEY_FILE} : renouvellement et révocation indisponibles. Colle la commande d'installation pour les activer.`}
          />
        )}
        {keyFile.inAuthorizedKeys && (
          <CheckRow
            ok={false}
            title="Clé aussi présente dans ~/.ssh/authorized_keys"
            detail="SSH Gate ne modifie jamais ce fichier : retires-en cette ligne toi-même, sinon la révocation et le renouvellement n'auront pas d'effet."
          />
        )}
      </div>
      {keyFile.allowedFrom && (
        <div className="muted-line">
          <Info size={16} />
          Si l'adresse de SSH Gate change, seul son accès est refusé : recolle alors la commande d'installation.
        </div>
      )}
    </>
  )
}

interface ServerModalProps {
  /** Serveur existant (étape d'installation), ou null pour en ajouter un. */
  server: ServerView | null
  onClose: () => void
  onSaved: (server: ServerView) => void
}

/** Ajout d'un serveur en trois étapes : saisie, commande d'installation, test de connexion. */
export function ServerModal({ server: initial, onClose, onSaved }: ServerModalProps) {
  const [server, setServer] = useState<ServerView | null>(initial)
  const [step, setStep] = useState<Step>(initial ? 'key' : 'form')
  const [fields, setFields] = useState<ServerFields>(
    initial ? { name: initial.name, host: initial.host, port: initial.port, username: initial.username } : { name: '', host: '', port: 22, username: '' }
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [result, setResult] = useState<{ fingerprint: string; cwd: string; keyFile: KeyFileStatus } | null>(null)

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
      setResult({ fingerprint: outcome.fingerprint, cwd: outcome.cwd, keyFile: outcome.keyFile })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const publicKey = server?.publicKey ?? null
  const command = publicKey ? installCommand(publicKey) : ''

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
  } else if (step === 'key' && server && publicKey) {
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
        <div className="key-section">
          <div className="section-title">
            Commande d'installation
            <CopyButton value={command} />
          </div>
          <div className="keybox clamp">{command}</div>
          <div className="key-caption">
            <span>Une seule ligne, à coller dans une session ouverte sur le serveur en tant que {server.username}.</span>
            <button className="link-btn" onClick={() => setShowKey(!showKey)}>
              {showKey ? 'Masquer la clé' : 'Clé publique seule'}
            </button>
          </div>
          {showKey && (
            <div className="oneliner">
              <span>{publicKey}</span>
              <CopyButton value={publicKey} compact />
            </div>
          )}
        </div>
        <div className="key-section">
          <div className="section-title">Ce qu'elle fait</div>
          <div className="does-row">
            <FileKey size={16} />
            Écrit la clé dans ~/{DEDICATED_KEY_FILE}, limitée par restrict,pty
          </div>
          <div className="does-row">
            <Settings size={16} />
            Fait lire ce fichier à sshd, en plus de ~/.ssh/authorized_keys (sudo)
          </div>
          <div className="does-row">
            <ShieldCheck size={16} />
            Vérifie la configuration avant de recharger sshd, et s'arrête si elle est invalide
          </div>
        </div>
        <div className="callout-warn">
          <TriangleAlert size={18} />
          <div>
            Ton fichier ~/.ssh/authorized_keys n'est pas modifié.
            <br />
            Garde quand même ta session ouverte jusqu'au test réussi.
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
      <TestResult {...result} />
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
          Retour à l'installation
        </button>
        <button className="btn btn-primary" onClick={() => void test()} disabled={busy}>
          Réessayer
        </button>
      </>
    )
  }

  return (
    <Modal title={initial ? `Installation — ${initial.name}` : 'Ajouter un serveur'} onClose={onClose} footer={footer}>
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

type StepState = 'todo' | 'done' | 'failed' | 'skipped'

interface StepItem {
  title: string
  detail: string
  state: StepState
}

/** Étapes numérotées d'une opération sur la clé, avec leur état. */
function KeySteps({ steps }: { steps: StepItem[] }) {
  return (
    <div className="key-steps">
      {steps.map((item, index) => (
        <div key={item.title} className={`key-step ${item.state}`}>
          <span className="key-step-dot">
            {item.state === 'done' ? <Check size={12} strokeWidth={3} /> : item.state === 'failed' ? <X size={12} strokeWidth={3} /> : index + 1}
          </span>
          <div>
            <div className="key-step-title">{item.title}</div>
            <div className="key-step-detail">{item.detail}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function CurrentKey({ server, label }: { server: ServerView; label: string }) {
  const parts = (server.publicKey ?? '').split(/\s+/)
  const body = parts[1] ?? ''
  const short = body.length > 20 ? `${body.slice(0, 8)}…${body.slice(-6)}` : body
  const created = server.keyCreatedAt ? ` · créée le ${new Date(server.keyCreatedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''
  return (
    <div className="current-key">
      <KeyRound size={20} />
      <div>
        <div className="current-key-label">
          {label}
          {created}
        </div>
        <div className="mono">{[parts[0], short, parts[2]].filter(Boolean).join(' ')}</div>
      </div>
    </div>
  )
}

interface KeyModalProps {
  server: ServerView
  onClose: () => void
  onSaved: (server: ServerView) => void
}

const ROTATION_STEPS: { title: string; detail: string }[] = [
  { title: 'Générer une nouvelle paire de clés', detail: "ed25519, la clé privée chiffrée comme l'actuelle" },
  { title: 'Ajouter la nouvelle clé publique sur le serveur', detail: `dans ~/${DEDICATED_KEY_FILE}, à côté de la clé actuelle` },
  { title: 'Ouvrir une connexion avec la nouvelle clé', detail: "une seconde connexion, pour vérifier qu'elle est acceptée" },
  { title: "Retirer l'ancienne clé", detail: 'le fichier ne garde que la nouvelle, seulement si la connexion a réussi' },
]

/** Renouvellement de la clé : confirmation, puis déroulé des quatre étapes. */
export function RotateKeyModal({ server, onClose, onSaved }: KeyModalProps) {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<RotationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function rotate() {
    setBusy(true)
    setError(null)
    try {
      const result = await api.rotateKey(server.id)
      setOutcome(result)
      onSaved(result.server)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const failedAt = outcome ? outcome.steps.indexOf('failed') : -1
  const steps: StepItem[] = ROTATION_STEPS.map((item, index) => {
    const status = outcome?.steps[index]
    const state: StepState = status === 'done' ? 'done' : status === 'failed' ? 'failed' : failedAt !== -1 && index > failedAt ? 'skipped' : 'todo'
    const detail = state === 'failed' ? (outcome?.error ?? item.detail) : state === 'skipped' ? 'non effectuée' : item.detail
    return { title: item.title, detail, state }
  })

  let summary: ReactNode = null
  if (outcome && !outcome.error) {
    summary = (
      <div className="result-ok">
        <CircleCheck size={20} style={{ flexShrink: 0 }} />
        <div>Clé renouvelée : le serveur n'accepte plus l'ancienne.</div>
      </div>
    )
  } else if (failedAt !== -1 && failedAt < 3) {
    summary = (
      <div className="safe-box">
        <ShieldCheck size={20} />
        <div>
          <div className="safe-title">Rien n'a été perdu</div>
          <div className="safe-detail">
            La nouvelle ligne a été retirée du fichier dédié et la nouvelle clé supprimée.
            <br />
            SSH Gate continue avec la clé actuelle ; ton authorized_keys n'a pas été touché.
          </div>
        </div>
      </div>
    )
  }

  const intro =
    failedAt !== -1
      ? `Le renouvellement s'est arrêté à l'étape ${failedAt + 1}.${failedAt < 3 ? ' Ta clé actuelle fonctionne toujours.' : ''}`
      : 'SSH Gate remplace la clé de ce serveur lui-même, en quatre étapes :'

  return (
    <Modal
      title={`Renouveler la clé de ${server.name}`}
      onClose={onClose}
      footer={
        outcome ? (
          <button className="btn btn-secondary" onClick={onClose}>
            Fermer
          </button>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button className="btn btn-primary" onClick={() => void rotate()} disabled={busy}>
              <RefreshCw size={16} />
              {busy ? 'Renouvellement…' : 'Renouveler la clé'}
            </button>
          </>
        )
      }
    >
      <div className="muted-line">{intro}</div>
      <KeySteps steps={steps} />
      {!outcome && <CurrentKey server={server} label="Clé actuelle" />}
      {!outcome && (
        <div className="muted-line">
          <ShieldCheck size={16} className="check-ok" />
          Seul le fichier dédié de SSH Gate est modifié. Ton ~/.ssh/authorized_keys n'est jamais touché.
        </div>
      )}
      {summary}
      {error && (
        <div className="result-ko">
          <CircleX size={20} style={{ flexShrink: 0 }} />
          <div>{error}</div>
        </div>
      )}
    </Modal>
  )
}

interface RevokeModalProps extends KeyModalProps {
  terminalCount: number
}

/** Révocation : SSH Gate vide son fichier, ferme ses connexions et efface la clé. */
export function RevokeKeyModal({ server, terminalCount, onClose, onSaved }: RevokeModalProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<ServerView>) {
    setBusy(true)
    try {
      onSaved(await action())
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const terminalsText = terminalCount > 1 ? `les ${terminalCount} terminaux ouverts` : 'le terminal ouvert'
  const connections = terminalCount > 0 ? `le shell de l'agent et ${terminalsText} sur ${server.name}` : "le shell de l'agent"
  const steps: StepItem[] = [
    { title: 'Vider le fichier dédié sur le serveur', detail: error ?? `~/${DEDICATED_KEY_FILE}, par la connexion actuelle`, state: error ? 'failed' : 'todo' },
    { title: 'Fermer les connexions de SSH Gate', detail: error ? 'en attente' : connections, state: error ? 'skipped' : 'todo' },
    { title: 'Effacer la clé privée', detail: error ? 'en attente' : 'le serveur reste dans la liste, sans clé : « Installer une clé » pour revenir', state: error ? 'skipped' : 'todo' },
  ]

  return (
    <Modal
      title={`Révoquer la clé de ${server.name}`}
      onClose={onClose}
      footer={
        error ? (
          <>
            <button className="btn btn-secondary" onClick={() => void run(() => api.revokeKey(server.id))} disabled={busy}>
              Réessayer
            </button>
            <button className="btn btn-danger-solid" onClick={() => void run(() => api.forgetKey(server.id))} disabled={busy}>
              <Trash2 size={16} />
              C'est fait, effacer la clé
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button className="btn btn-danger-solid" onClick={() => void run(() => api.revokeKey(server.id))} disabled={busy}>
              <Ban size={16} />
              {busy ? 'Révocation…' : 'Révoquer la clé'}
            </button>
          </>
        )
      }
    >
      <div className="muted-line">
        {error ? "SSH Gate n'a pas pu retirer sa clé du serveur." : "SSH Gate n'aura plus accès à ce serveur. Ton propre accès SSH n'est pas touché."}
      </div>
      <KeySteps steps={steps} />
      {error ? (
        <div className="key-section">
          <div className="section-title">Commande à lancer toi-même sur le serveur</div>
          <div className="oneliner">
            <span>{REVOKE_COMMAND}</span>
            <CopyButton value={REVOKE_COMMAND} compact />
          </div>
          <div className="muted-line">
            <Info size={16} />
            Une fois la commande lancée, SSH Gate efface sa clé privée et ferme ses connexions.
          </div>
        </div>
      ) : (
        <>
          <CurrentKey server={server} label="Clé à révoquer" />
          <div className="muted-line">
            <Info size={16} />
            Si le serveur ne répond pas, SSH Gate te donnera la commande à lancer toi-même.
          </div>
        </>
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
        La paire de clés et l'historique des commandes de ce serveur seront effacés, sans toucher au serveur. Pour couper aussi l'accès, révoque d'abord la clé, ou
        lance <span className="mono">{REVOKE_COMMAND}</span> en tant que {server.username} sur {server.host}.
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

const PALETTE_CHOICES: { id: HighlightPalette; name: string }[] = [
  { id: 'sobre', name: 'Sobre' },
  { id: 'contrastee', name: 'Contrastée' },
  { id: 'vive', name: 'Vive' },
  { id: 'minimale', name: 'Minimale' },
  { id: 'aucune', name: 'Aucune' },
]

const PALETTE_SAMPLE = 'sudo journalctl -u nginx | grep "failed"'

/** Réglages de l'interface : choix de la palette de coloration des commandes, appliqué dès le clic. */
export function SettingsModal({
  palette,
  onClose,
  onChanged,
  onError,
}: {
  palette: HighlightPalette
  onClose: () => void
  onChanged: () => void
  onError: (message: string) => void
}) {
  const [selected, setSelected] = useState(palette)
  const [busy, setBusy] = useState(false)

  async function choose(id: HighlightPalette) {
    if (id === selected || busy) return
    const previous = selected
    setSelected(id)
    setBusy(true)
    try {
      await api.setPalette(id)
      onChanged()
    } catch (err) {
      setSelected(previous)
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Réglages"
      onClose={onClose}
      footer={
        <>
          <span className="modal-foot-note">Appliqué immédiatement.</span>
          <button className="btn btn-secondary" onClick={onClose}>
            Fermer
          </button>
        </>
      }
    >
      <div className="settings-section-title">Coloration des commandes</div>
      <div className="settings-help">Demandes, exécution et journal. Le champ de modification reste sans couleur.</div>
      <div className="palette-list" role="radiogroup" aria-label="Palette de coloration">
        {PALETTE_CHOICES.map((choice) => (
          <button
            key={choice.id}
            role="radio"
            aria-checked={choice.id === selected}
            className={`palette-option${choice.id === selected ? ' selected' : ''}`}
            onClick={() => void choose(choice.id)}
          >
            <span className="palette-radio" />
            <span className="palette-name">{choice.name}</span>
            <span className="palette-sample" data-palette={choice.id}>
              <CommandText command={PALETTE_SAMPLE} />
            </span>
          </button>
        ))}
      </div>
    </Modal>
  )
}
