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

/** Ancienneté d'un instant : `à l'instant`, `il y a 12 min`, `il y a 3 h`, `le 4 nov.`. */
export function ago(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'à l’instant'
  if (minutes < 60) return `il y a ${minutes} min`
  if (minutes < 24 * 60) return `il y a ${Math.floor(minutes / 60)} h`
  return `le ${new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count > 1 ? pluralForm : singular}`
}

/** Ancienneté courte d'un instant : `2 min`, `9 h`. */
export function shortAge(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`
}

/** Délai jusqu'à un instant à venir : `dans 34 h`, `dans 12 min`, `dans un instant`. */
export function within(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((Date.parse(iso) - now) / 60_000)
  if (minutes < 1) return 'dans un instant'
  if (minutes < 60) return `dans ${minutes} min`
  return `dans ${Math.floor(minutes / 60)} h`
}
