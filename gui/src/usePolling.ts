import { useCallback, useEffect, useRef, useState } from 'react'

export interface Polled<T> {
  data: T | null
  error: string | null
  /** Relance une lecture tout de suite, par exemple après une action. */
  reload: () => void
}

/**
 * Lit `fetcher` tout de suite, puis `intervalMs` après la fin de chaque lecture,
 * sans requêtes simultanées. Changer de `key` repart de zéro.
 */
export function usePolling<T>(key: string, fetcher: () => Promise<T>, intervalMs: number): Polled<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null }>({ key, data: null, error: null })
  const fetcherRef = useRef(fetcher)
  const intervalRef = useRef(intervalMs)
  const wakeRef = useRef<() => void>(() => {})

  useEffect(() => {
    fetcherRef.current = fetcher
    intervalRef.current = intervalMs
  })

  useEffect(() => {
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function poll() {
      if (running) return
      running = true
      clearTimeout(timer)
      try {
        const data = await fetcherRef.current()
        if (!stopped) setState({ key, data, error: null })
      } catch (err) {
        if (!stopped) setState((previous) => ({ key, data: previous.key === key ? previous.data : null, error: (err as Error).message }))
      }
      running = false
      if (!stopped) timer = setTimeout(poll, intervalRef.current)
    }

    wakeRef.current = () => void poll()
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [key])

  const reload = useCallback(() => wakeRef.current(), [])
  const current = state.key === key ? state : { data: null, error: null }
  return { data: current.data, error: current.error, reload }
}
