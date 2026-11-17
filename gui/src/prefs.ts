import { useState } from 'react'

export const SIDEBAR_DEFAULT_WIDTH = 260
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 560

const SIDEBAR_COOKIE = 'ssh-gate-sidebar-width'
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60
const LAST_VIEWS_KEY = 'ssh-gate.last-views'

function readCookie(name: string): string | null {
  const prefix = `${name}=`
  const entry = document.cookie.split('; ').find((part) => part.startsWith(prefix))
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : null
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${COOKIE_MAX_AGE_SECONDS}; path=/; SameSite=Lax`
}

export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)))
}

/** Largeur de la barre latérale, mémorisée dans un cookie du navigateur. */
export function useSidebarWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => {
    const saved = Number(readCookie(SIDEBAR_COOKIE))
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH
  })
  function update(next: number) {
    const clamped = clampSidebarWidth(next)
    setWidth(clamped)
    writeCookie(SIDEBAR_COOKIE, String(clamped))
  }
  return [width, update]
}

/** Dernier onglet ouvert dans un serveur : une session (null pour « Vous ») ou ses terminaux. */
export type LastView = { kind: 'session'; sessionId: string | null } | { kind: 'terminals' }

/** Derniers onglets ouverts par serveur, gardés par ce navigateur. */
export function readLastViews(): Record<string, LastView> {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_VIEWS_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeLastViews(views: Record<string, LastView>): void {
  try {
    localStorage.setItem(LAST_VIEWS_KEY, JSON.stringify(views))
  } catch {
    // Stockage indisponible (navigation privée, données bloquées) : le choix vaut pour la page ouverte.
  }
}
