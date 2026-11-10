import { useEffect, useRef, useState } from 'react'
import { CircleX, Info, NotebookPen, Pencil } from 'lucide-react'
import { MAX_NOTES_LENGTH, type ServerView } from '@shared/model'
import { api } from '../api'

function updatedLine(server: ServerView): string {
  if (!server.notesUpdatedAt) return 'aucune note pour l’instant'
  const date = new Date(server.notesUpdatedAt)
  const today = new Date().toDateString() === date.toDateString()
  const when = today
    ? `aujourd’hui à ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
    : `le ${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })} à ${date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
  return `mises à jour ${server.notesUpdatedBy === 'agent' ? 'par l’agent' : 'par toi'} ${when}`
}

interface Props {
  server: ServerView
  onSaved: () => void
}

/** Notes du serveur : lecture, et modification dans une zone de texte libre. */
export function NotesView({ server, onSaved }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [base, setBase] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const field = fieldRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${Math.max(field.scrollHeight, 240)}px`
  }, [draft, editing])

  function startEdit() {
    setDraft(server.notes)
    setBase(server.notesUpdatedAt)
    setError(null)
    setEditing(true)
    requestAnimationFrame(() => fieldRef.current?.focus())
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await api.updateNotes(server.id, draft, base)
      setEditing(false)
      onSaved()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="notes-card">
      <div className="notes-head">
        <NotebookPen size={20} />
        <div>
          <div className="card-title">Notes sur le serveur</div>
          <div className="notes-meta">{updatedLine(server)}</div>
        </div>
        {!editing && (
          <button className="btn btn-secondary notes-edit" onClick={startEdit}>
            <Pencil size={16} />
            Modifier
          </button>
        )}
      </div>
      <div className="notes-divider" />

      {editing ? (
        <textarea
          ref={fieldRef}
          className="textarea notes-field"
          value={draft}
          maxLength={MAX_NOTES_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          placeholder="Dossier des sites, gestion des applis (PM2, systemd…), emplacement des configurations, règles à respecter…"
        />
      ) : server.notes ? (
        <div className="notes-body">{server.notes}</div>
      ) : (
        <div className="notes-empty">
          Aucune note. L’agent y consigne ce qu’il apprend sur ce serveur ; tu peux aussi les écrire toi-même.
        </div>
      )}

      {error && (
        <div className="result-ko">
          <CircleX size={20} style={{ flexShrink: 0 }} />
          <div>{error}</div>
        </div>
      )}

      <div className="card-foot">
        <span className="hint">
          <Info size={16} />
          {editing
            ? 'Texte libre. L’agent lit la version enregistrée dès sa prochaine intervention.'
            : 'L’agent lit ces notes avant chaque intervention sur ce serveur, et les complète quand il découvre quelque chose d’utile.'}
        </span>
        {editing && (
          <>
            <button className="btn btn-secondary" onClick={() => setEditing(false)} disabled={saving}>
              Annuler
            </button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
              Enregistrer
            </button>
          </>
        )}
      </div>
    </section>
  )
}
