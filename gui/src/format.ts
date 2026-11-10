/** Heure locale `14:07`. */
export function clock(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
}

/** Durée `3,1 s` entre deux instants. */
export function seconds(from: string | null, to: string | null): string {
  if (!from || !to) return ''
  return `${((Date.parse(to) - Date.parse(from)) / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`
}

/** Temps écoulé `1:05` depuis un instant. */
export function elapsed(from: string | null, now: number): string {
  if (!from) return ''
  const total = Math.max(0, Math.floor((now - Date.parse(from)) / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`
}
