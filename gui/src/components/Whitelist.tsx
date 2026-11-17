import { useEffect, useState, type KeyboardEvent } from 'react'
import { Check, CircleAlert, CircleCheck, CornerDownRight, Globe, ListChecks, Pencil, Plus, Server, ServerOff, Ban, Trash2, X } from 'lucide-react'
import type { CommandEvaluation, SegmentEvaluation, ServerView, WhitelistMode, WhitelistResponse, WhitelistRule, WhitelistRuleInput } from '@shared/model'
import { api } from '../api'
import { plural } from '../format'
import { usePolling } from '../usePolling'
import { Modal } from './Modals'

const MODES: { id: WhitelistMode; label: string }[] = [
  { id: 'off', label: 'Désactivée' },
  { id: 'observe', label: 'Observation' },
  { id: 'active', label: 'Active' },
]

/** Liste visée : l'identifiant d'un serveur, ou null pour la liste commune. */
export type WhitelistScope = string | null

function SegmentIcon({ segment }: { segment: SegmentEvaluation }) {
  if (segment.verdict === 'covered') return <CircleCheck size={16} className="status-ok" />
  if (segment.verdict === 'excluded') return <Ban size={16} className="status-ko" />
  return <CircleAlert size={16} className="status-warn" />
}

interface SegmentListProps {
  evaluation: CommandEvaluation
  /** Ouvre la fenêtre « Autoriser » pour une partie non couverte. */
  onAuthorize?: (segment: SegmentEvaluation) => void
}

/** Parties d'une commande, chacune avec son séparateur, son verdict et la règle ou la raison. */
export function SegmentList({ evaluation, onAuthorize }: SegmentListProps) {
  return (
    <div className="seg-list">
      {evaluation.segments.map((segment, index) => (
        <div key={index} className={`seg-row ${segment.verdict}`}>
          <span className="seg-sep">{segment.separator ?? ''}</span>
          <SegmentIcon segment={segment} />
          <span className="seg-text mono" title={segment.text}>
            {segment.text}
          </span>
          <span className="seg-why" title={segment.rule ?? segment.reason ?? undefined}>
            {segment.verdict === 'covered' ? segment.rule : segment.reason}
          </span>
          {segment.verdict === 'uncovered' && onAuthorize ? (
            <button className="btn btn-secondary btn-sm" onClick={() => onAuthorize(segment)}>
              <Plus size={14} />
              Autoriser…
            </button>
          ) : (
            <span />
          )}
        </div>
      ))}
    </div>
  )
}

/** Bilan d'une ou plusieurs commandes : « 2 parties sur 4 hors liste blanche ». */
export function segmentSummary(evaluations: CommandEvaluation[]): string {
  const segments = evaluations.flatMap((evaluation) => evaluation.segments)
  const outside = segments.filter((segment) => segment.verdict !== 'covered').length
  if (outside === 0) return segments.length > 1 ? `les ${segments.length} parties sont couvertes` : 'couverte par la liste blanche'
  return `${outside} ${outside > 1 ? 'parties' : 'partie'} sur ${segments.length} hors liste blanche`
}

function scopeLabel(scope: WhitelistScope, servers: ServerView[]): string {
  if (scope === null) return 'Liste commune'
  return `${servers.find((s) => s.id === scope)?.name ?? scope} uniquement`
}

/** Origine d'une règle ouverte depuis une demande en attente. */
export interface RuleOrigin {
  /** Partie de la commande à autoriser, telle qu'elle est écrite. */
  text: string
  sessionName: string
  /** Autres parties de la demande qui ne sont pas couvertes. */
  otherPending: string[]
}

interface RuleModalProps {
  servers: ServerView[]
  /** Listes proposées : la liste commune, et le serveur concerné s'il y en a un. */
  scopes: WhitelistScope[]
  initialScope: WhitelistScope
  /** Commande à autoriser ; vide pour une règle saisie de zéro. */
  command: string
  /** Forme ajoutée d'office, tirée de la demande. */
  prefillForm: string | null
  prefillSudo: boolean
  origin: RuleOrigin | null
  onClose: () => void
  onSaved: () => void
}

interface Draft {
  command: string
  anyUse: boolean
  forms: string[]
  deny: string[]
  sudo: boolean
}

function draftFor(rule: WhitelistRule | undefined, command: string, prefillForm: string | null, prefillSudo: boolean): Draft {
  const forms = rule && !rule.anyUse ? [...rule.forms] : []
  if (prefillForm !== null && !forms.includes(prefillForm) && !rule?.anyUse) forms.push(prefillForm)
  return {
    command,
    anyUse: rule?.anyUse ?? false,
    forms,
    deny: rule ? [...rule.deny] : [],
    sudo: (rule?.sudo ?? false) || prefillSudo,
  }
}

function rulesOf(whitelist: WhitelistResponse, scope: WhitelistScope): WhitelistRule[] {
  return scope === null ? whitelist.common : whitelist.servers.find((s) => s.serverId === scope)?.rules ?? []
}

/**
 * Création ou modification de la règle d'une commande dans une liste. Changer de liste
 * charge la règle existante de cette liste pour la même commande.
 */
export function RuleModal({ servers, scopes, initialScope, command, prefillForm, prefillSudo, origin, onClose, onSaved }: RuleModalProps) {
  const [whitelist, setWhitelist] = useState<WhitelistResponse | null>(null)
  const [scope, setScope] = useState<WhitelistScope>(initialScope)
  const [draft, setDraft] = useState<Draft>(() => draftFor(undefined, command, prefillForm, prefillSudo))
  const [formInput, setFormInput] = useState('')
  const [denyInput, setDenyInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.whitelist().then(setWhitelist, (err: Error) => setError(err.message))
  }, [])

  const name = draft.command.trim()
  const existing = whitelist && command ? rulesOf(whitelist, scope).find((rule) => rule.command === command) : undefined

  useEffect(() => {
    if (!whitelist) return
    const rule = rulesOf(whitelist, scope).find((r) => r.command === command)
    setDraft((current) => ({ ...draftFor(rule, current.command, prefillForm, prefillSudo) }))
  }, [whitelist, scope, command, prefillForm, prefillSudo])

  function addForm() {
    const form = formInput.trim().split(/\s+/).filter(Boolean).join(' ')
    if (form && !draft.forms.includes(form)) setDraft({ ...draft, forms: [...draft.forms, form] })
    setFormInput('')
  }

  function addDeny() {
    const values = denyInput.split(/[\s,]+/).filter(Boolean)
    setDraft({ ...draft, deny: [...new Set([...draft.deny, ...values])] })
    setDenyInput('')
  }

  function onEnter(event: KeyboardEvent<HTMLInputElement>, fn: () => void) {
    if (event.key === 'Enter') {
      event.preventDefault()
      fn()
    }
  }

  async function save() {
    const pendingForm = formInput.trim()
    const pendingDeny = denyInput.split(/[\s,]+/).filter(Boolean)
    const input: WhitelistRuleInput = {
      command: name,
      anyUse: draft.anyUse,
      forms: pendingForm ? [...draft.forms, pendingForm] : draft.forms,
      deny: [...new Set([...draft.deny, ...pendingDeny])],
      sudo: draft.sudo,
    }
    setSaving(true)
    setError(null)
    try {
      if (existing) await api.updateRule(existing.id, scope, input)
      else await api.addRule(scope, input)
      onSaved()
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  const title = origin ? `Autoriser ${command}` : command ? `Règle ${command}` : 'Nouvelle règle'

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          {origin && (
            <span className="modal-foot-note rule-effect">
              La demande sera réévaluée{origin.otherPending.length > 0 ? ` : ${origin.otherPending.join(', ')} ${origin.otherPending.length > 1 ? 'resteront' : 'restera'} à valider.` : '.'}
            </span>
          )}
          <button className="btn btn-secondary" onClick={onClose}>
            Annuler
          </button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={saving || !whitelist || !name}>
            Enregistrer
          </button>
        </>
      }
    >
      {origin && (
        <div>
          <div className="settings-help">Pré-remplie depuis la demande de {origin.sessionName}</div>
          <div className="rule-origin mono">{origin.text}</div>
        </div>
      )}

      {!command && (
        <div>
          <div className="field-label">Commande</div>
          <input className="input mono" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="systemctl" autoFocus />
        </div>
      )}

      {scopes.length > 1 && (
        <div>
          <div className="field-label">Portée</div>
          <div className="segmented" role="radiogroup" aria-label="Portée">
            {scopes.map((option) => (
              <button key={option ?? 'common'} role="radio" aria-checked={scope === option} className={scope === option ? 'selected' : ''} onClick={() => setScope(option)}>
                {option === null ? <Globe size={14} /> : <Server size={14} />}
                {scopeLabel(option, servers)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="field-label">Utilisation</div>
        <div className="rule-radios" role="radiogroup" aria-label="Utilisation">
          <button role="radio" aria-checked={draft.anyUse} className={`rule-radio${draft.anyUse ? ' selected' : ''}`} onClick={() => setDraft({ ...draft, anyUse: true })}>
            <span className="palette-radio" />
            Toute utilisation
          </button>
          <button role="radio" aria-checked={!draft.anyUse} className={`rule-radio${!draft.anyUse ? ' selected' : ''}`} onClick={() => setDraft({ ...draft, anyUse: false })}>
            <span className="palette-radio" />
            Seulement ces formes
          </button>
        </div>
        {!draft.anyUse && (
          <div className="rule-forms">
            {draft.forms.map((form) => (
              <div key={form} className={`rule-form${form === prefillForm ? ' fresh' : ''}`}>
                <span className="rule-form-cmd mono">{name || 'commande'}</span>
                <span className="rule-form-args mono">{form}</span>
                {form === prefillForm && <span className="chip chip-sm agent">de la demande</span>}
                <button className="icon-btn" title="Retirer" onClick={() => setDraft({ ...draft, forms: draft.forms.filter((f) => f !== form) })}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <div className="rule-form add">
              <Plus size={14} />
              <input
                className="rule-form-input mono"
                value={formInput}
                onChange={(e) => setFormInput(e.target.value)}
                onKeyDown={(e) => onEnter(e, addForm)}
                onBlur={addForm}
                placeholder="Ajouter une forme, ex. restart nginx"
              />
            </div>
            <div className="settings-help">* = n'importe quels arguments à cet endroit. Les options peuvent être dans le désordre ; -rf est lu comme -r -f.</div>
          </div>
        )}
      </div>

      <div>
        <div className="field-label">Toujours refuser</div>
        <div className="deny-field">
          {draft.deny.map((value) => (
            <span key={value} className="deny-chip mono">
              {value}
              <button title="Retirer" onClick={() => setDraft({ ...draft, deny: draft.deny.filter((d) => d !== value) })}>
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            className="deny-input mono"
            value={denyInput}
            onChange={(e) => setDenyInput(e.target.value)}
            onKeyDown={(e) => onEnter(e, addDeny)}
            onBlur={addDeny}
            placeholder={draft.deny.length ? '' : 'Mots ou options refusés même dans une forme autorisée, ex. --force'}
          />
        </div>
      </div>

      <label className="rule-check">
        <input type="checkbox" checked={draft.sudo} onChange={(e) => setDraft({ ...draft, sudo: e.target.checked })} />
        <span>Autoriser avec sudo</span>
        {prefillSudo && <span className="muted-note">cochée car la demande l'utilise</span>}
      </label>

      {error && <div className="result-ko">{error}</div>}
    </Modal>
  )
}

interface ScreenProps {
  servers: ServerView[]
  scope: WhitelistScope
  onScope: (scope: WhitelistScope) => void
  onError: (message: string) => void
}

type Editing = { rule: WhitelistRule | null } | null

/** Page de la liste blanche : un onglet pour la liste commune, un par serveur. */
export function WhitelistScreen({ servers, scope, onScope, onError }: ScreenProps) {
  const polled = usePolling('whitelist', api.whitelist, 5000)
  const [editing, setEditing] = useState<Editing>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [testInput, setTestInput] = useState('')
  const [tested, setTested] = useState<{ scope: WhitelistScope; evaluation: CommandEvaluation } | null>(null)

  const whitelist = polled.data
  const server = scope === null ? null : servers.find((s) => s.id === scope) ?? null
  const serverList = whitelist?.servers.find((s) => s.serverId === scope)
  const rules = whitelist ? rulesOf(whitelist, scope) : []
  const mode = serverList?.mode ?? 'off'

  async function setMode(next: WhitelistMode) {
    if (!server || next === mode) return
    try {
      await api.setWhitelistMode(server.id, next)
      polled.reload()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteRule(id)
      setConfirmDelete(null)
      polled.reload()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  async function runTest() {
    const command = testInput.trim()
    if (!command) return
    try {
      const response = await api.testWhitelist(scope, command)
      setTested({ scope, evaluation: response.evaluation })
    } catch (err) {
      onError((err as Error).message)
    }
  }

  const result = tested && tested.scope === scope ? tested.evaluation : null
  const usedRules = result ? [...new Set(result.segments.map((s) => s.rule).filter((r): r is string => !!r))] : []

  return (
    <main className="main">
      <header className="wl-head">
        <div className="wl-title">Liste blanche</div>
        <div className="wl-sub">Une commande dont chaque partie est couverte s'exécute sans attendre ton accord.</div>
      </header>

      <div className="content wl-content">
        <div className="wl-toolbar">
          <div className="wl-tabs" role="tablist">
            <button role="tab" aria-selected={scope === null} className={`wl-tab${scope === null ? ' selected' : ''}`} onClick={() => onScope(null)}>
              <Globe size={14} />
              Commune
              <span className="wl-tab-count">{whitelist?.common.length ?? ''}</span>
            </button>
            {servers.map((s) => {
              const entry = whitelist?.servers.find((w) => w.serverId === s.id)
              const off = !entry || entry.mode === 'off'
              const Icon = off ? ServerOff : Server
              return (
                <button key={s.id} role="tab" aria-selected={scope === s.id} className={`wl-tab${scope === s.id ? ' selected' : ''}${off ? ' off' : ''}`} onClick={() => onScope(s.id)}>
                  <Icon size={14} />
                  {s.name}
                  <span className="wl-tab-count">{off ? 'off' : entry.rules.length}</span>
                </button>
              )
            })}
          </div>
          <span className="topbar-spacer" />
          {server && (
            <div className="segmented" role="radiogroup" aria-label={`Liste blanche de ${server.name}`}>
              {MODES.map((option) => (
                <button key={option.id} role="radio" aria-checked={mode === option.id} className={`${mode === option.id ? 'selected' : ''} mode-${option.id}`} onClick={() => void setMode(option.id)}>
                  {option.id === 'active' && mode === 'active' && <span className="dot on small" />}
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <button className="btn btn-primary" onClick={() => setEditing({ rule: null })} disabled={!whitelist}>
            <Plus size={16} />
            Ajouter une règle
          </button>
        </div>

        <div className="wl-inherit">
          <CornerDownRight size={14} />
          {server
            ? mode === 'off'
              ? `Liste blanche désactivée : toutes les demandes sur ${server.name} restent à valider.`
              : `${server.name} applique aussi ${plural(whitelist?.common.length ?? 0, 'règle', 'règles')} de la liste commune.${mode === 'observe' ? ' Mode Observation : rien ne s’exécute sans toi, chaque demande indique si elle aurait été approuvée.' : ''}`
            : 'Ces règles valent pour chaque serveur dont la liste blanche est en Observation ou Active.'}
        </div>

        <div className="wl-table">
          <div className="wl-row wl-row-head">
            <span>COMMANDE</span>
            <span>FORMES AUTORISÉES</span>
            <span>TOUJOURS REFUSÉ</span>
            <span>SUDO</span>
            <span />
          </div>
          {rules.length === 0 && <div className="wl-empty">{whitelist ? 'Aucune règle dans cette liste.' : polled.error ?? 'Chargement…'}</div>}
          {rules.map((rule) => (
            <div key={rule.id} className="wl-row">
              <span className="wl-cmd mono">{rule.command}</span>
              <span className="wl-chips">
                {rule.anyUse ? (
                  <span className="wl-any">Toute utilisation</span>
                ) : (
                  rule.forms.map((form) => (
                    <span key={form} className="wl-chip mono">
                      {form}
                    </span>
                  ))
                )}
              </span>
              <span className="wl-chips">
                {rule.deny.length === 0 ? (
                  <span className="wl-none">—</span>
                ) : (
                  rule.deny.map((value) => (
                    <span key={value} className="wl-chip deny mono">
                      {value}
                    </span>
                  ))
                )}
              </span>
              <span>{rule.sudo ? <span className="chip chip-sm agent">autorisé</span> : <span className="wl-none">—</span>}</span>
              <span className="wl-actions">
                {confirmDelete === rule.id ? (
                  <>
                    <button className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(null)}>
                      Annuler
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={() => void remove(rule.id)}>
                      Supprimer
                    </button>
                  </>
                ) : (
                  <>
                    <button className="icon-btn" title="Modifier" onClick={() => setEditing({ rule })}>
                      <Pencil size={16} />
                    </button>
                    <button className="icon-btn" title="Supprimer" onClick={() => setConfirmDelete(rule.id)}>
                      <Trash2 size={16} />
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>

        <div className="wl-test">
          <div className="field-label">Tester une commande {server ? `sur ${server.name}` : 'avec la liste commune'}</div>
          <div className="prompt">
            <span className="prompt-sign">$</span>
            <input
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runTest()
              }}
              placeholder="cd /var/log && tail -n 200 nginx/error.log | grep -i timeout"
            />
            <button className="btn btn-secondary btn-sm" onClick={() => void runTest()} disabled={!testInput.trim()}>
              <ListChecks size={14} />
              Tester
            </button>
          </div>
          {result && (
            <>
              <SegmentList evaluation={result} />
              <div className={result.covered ? 'wl-verdict ok' : 'wl-verdict'}>
                {result.covered ? (
                  <>
                    <Check size={14} />
                    S'exécuterait sans demande · {usedRules.join(', ')}
                  </>
                ) : (
                  `Resterait à valider : ${segmentSummary([result])}`
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {editing && (
        <RuleModal
          servers={servers}
          scopes={editing.rule || scope === null ? [scope] : [scope, null]}
          initialScope={scope}
          command={editing.rule?.command ?? ''}
          prefillForm={null}
          prefillSudo={false}
          origin={null}
          onClose={() => setEditing(null)}
          onSaved={polled.reload}
        />
      )}
    </main>
  )
}
