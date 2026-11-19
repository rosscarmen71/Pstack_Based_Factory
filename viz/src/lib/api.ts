import type {
  Envelope,
  EventRow,
  EventsPage,
  FeedItem,
  GateResult,
  HealthResponse,
  Need,
  OrderDetail,
  OrderSummary,
  PromptsResponse,
} from './types'

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res.json()
}

export function fetchSessions(): Promise<OrderSummary[]> {
  return getJson('/api/sessions') as Promise<OrderSummary[]>
}

export async function fetchSession(adwId: string): Promise<OrderDetail> {
  const detail = (await getJson(`/api/sessions/${encodeURIComponent(adwId)}`)) as OrderDetail
  return {
    session: detail.session,
    usage: detail.usage ?? { read: 0, written: 0 },
    phases: detail.phases ?? [],
    agents: detail.agents ?? [],
    order_status: detail.order_status,
    lane_meta: detail.lane_meta ?? {},
    loop_stops: detail.loop_stops ?? [],
    needs: detail.needs ?? [],
  }
}

export function fetchNeeds(adwId: string): Promise<Need[]> {
  return getJson(`/api/sessions/${encodeURIComponent(adwId)}/needs`) as Promise<Need[]>
}

export interface FeedPage {
  items: FeedItem[]
  cursor: number
  live: boolean
}

export function fetchFeed(uuid: string, after = 0): Promise<FeedPage> {
  return getJson(`/api/runs/${encodeURIComponent(uuid)}/feed?after=${after}`) as Promise<FeedPage>
}

export interface TakeOverResult {
  ok: boolean
  session: string
  fork: boolean
}

/** Opens a Terminal on the server's machine, resuming this run's conversation. */
export async function takeOver(uuid: string): Promise<TakeOverResult> {
  const url = `/api/takeover/${encodeURIComponent(uuid)}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `POST ${url} → ${res.status}`)
  }
  return (await res.json()) as TakeOverResult
}

export interface CustomizeTerminalResult {
  ok: boolean
  /** "focused": the agent's existing window came forward. "opened": it was gone, so a new one runs /customize_order. */
  action: 'focused' | 'opened'
}

/** Brings the Terminal window where /customize_order is grilling you to the front, or reopens it. */
export async function openCustomizeTerminal(pr: number): Promise<CustomizeTerminalResult> {
  const url = `/api/customize-terminal/${pr}`
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `POST ${url} → ${res.status}`)
  }
  return (await res.json()) as CustomizeTerminalResult
}

export async function fetchEvents(adwId: string, after: number, limit = 500): Promise<EventsPage> {
  const page = (await getJson(
    `/api/sessions/${encodeURIComponent(adwId)}/events?after=${after}&limit=${limit}`,
  )) as EventsPage | EventRow[]
  if (Array.isArray(page)) {
    const cursor = page.reduce((max, e) => Math.max(max, e.rowid), after)
    return { events: page, cursor, has_more: page.length === limit }
  }
  return { events: page.events ?? [], cursor: page.cursor ?? after, has_more: page.has_more ?? false }
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson('/api/health') as Promise<HealthResponse>
}

// PhaseDetail imports the prompts type from here alongside fetchPrompts.
export type { PromptsResponse }

export async function fetchPrompts(adwId: string, agent: string): Promise<PromptsResponse> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(adwId)}/agents/${encodeURIComponent(agent)}/prompts`,
  )
  // Not recorded (or endpoint not deployed yet) renders as "no prompts", not an error.
  if (res.status === 404) return { system: null, user: null }
  if (!res.ok) throw new Error(`GET prompts → ${res.status}`)
  const data = (await res.json()) as Partial<PromptsResponse>
  return { system: data.system ?? null, user: data.user ?? null }
}

export function fetchEnvelopes(adwId: string): Promise<Envelope[]> {
  return getJson(`/api/sessions/${encodeURIComponent(adwId)}/envelopes`) as Promise<Envelope[]>
}

export function fetchGates(adwId: string): Promise<GateResult[]> {
  return getJson(`/api/sessions/${encodeURIComponent(adwId)}/gates`) as Promise<GateResult[]>
}
