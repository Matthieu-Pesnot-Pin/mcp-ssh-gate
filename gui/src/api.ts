import type { GateRequest, RequestsResponse, ServerView, StateResponse, TestConnectionResponse } from '@shared/model'

export interface ServerFields {
  name: string
  host: string
  port: number
  username: string
}

/** Les routes sont relatives : l'interface est montée derrière un préfixe résolu par la balise <base>. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`api/${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = await response.json()
      if (body?.error) message = body.error
    } catch {
      // Réponse non JSON : le code HTTP reste le seul message disponible.
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method, body: JSON.stringify(body ?? {}) })
}

const server = (id: string) => `servers/${encodeURIComponent(id)}`
const req = (id: string) => `requests/${encodeURIComponent(id)}`

export const api = {
  state: () => request<StateResponse>('state'),
  requests: (serverId: string) => request<RequestsResponse>(`${server(serverId)}/requests?limit=60`),
  addServer: (fields: ServerFields) => send<ServerView>('POST', 'servers', fields),
  updateServer: (id: string, fields: ServerFields) => send<ServerView>('PUT', server(id), fields),
  deleteServer: (id: string) => send<{ deleted: true }>('DELETE', server(id)),
  testConnection: (id: string) => send<TestConnectionResponse>('POST', `${server(id)}/test`),
  updateNotes: (id: string, notes: string, expectedUpdatedAt: string | null) =>
    send<ServerView>('PUT', `${server(id)}/notes`, { notes, expectedUpdatedAt }),
  disconnect: (id: string) => send<ServerView>('POST', `${server(id)}/disconnect`),
  runManual: (id: string, command: string) => send<GateRequest>('POST', `${server(id)}/manual`, { command }),
  editCommand: (id: string, index: number, command: string) => send<GateRequest>('PUT', `${req(id)}/commands/${index}`, { command }),
  removeCommand: (id: string, index: number) => send<GateRequest>('DELETE', `${req(id)}/commands/${index}`),
  approve: (id: string, note: string) => send<GateRequest>('POST', `${req(id)}/approve`, { note }),
  refuse: (id: string, note: string) => send<GateRequest>('POST', `${req(id)}/refuse`, { note }),
  share: (id: string) => send<GateRequest>('POST', `${req(id)}/share`),
  interrupt: (id: string) => send<{ interrupted: true }>('POST', `${req(id)}/interrupt`),
}
