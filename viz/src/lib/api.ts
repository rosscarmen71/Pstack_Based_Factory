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
import type { AnswerBody, CustomizeState, ReplyBody } from '@shared/customize'

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

async function sendJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `POST ${url} → ${res.status}`)
  }
}

/** The /customize_order agent for this PR: its status and the questions it is waiting on. */
export function getCustomize(pr: number, project?: string | null): Promise<CustomizeState> {
  return getJson(`/api/customize/${pr}${inProject(project)}`) as Promise<CustomizeState>
}

/** PR numbers repeat across repositories: `?project=owner/repo` says which one is meant. */
const inProject = (project?: string | null): string => (project ? `?project=${encodeURIComponent(project)}` : '')

/** Answers the pending question card. */
export function answerCustomize(pr: number, body: AnswerBody, project?: string | null): Promise<void> {
  return sendJson(`/api/customize/${pr}/answer${inProject(project)}`, body)
}

/** Free-text reply, for when the agent asked in plain text. */
export function replyCustomize(pr: number, body: ReplyBody, project?: string | null): Promise<void> {
  return sendJson(`/api/customize/${pr}/reply${inProject(project)}`, body)
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

// ── Factory controls ─────────────────────────────────────────────────────────

import type { DeletePreview, DeleteReport } from '../../../factory/delete-task'
import type { LoopState } from '../../../factory/loop'
import type { ModeInfo, Settings } from '../../../factory/settings'
import type { TaskMode } from '../../../factory/tasks.schema'

export type { DeletePreview, DeleteReport, LoopState, ModeInfo, Settings, TaskMode }

/** GET /api/factory: the factory-wide switches and what the loop is doing right now. */
/** One project: a repository the factory manages. */
export interface ProjectInfo {
  /** "owner/repo". */
  name: string
  path: string
  paused: boolean
  dependsOn: string[]
  /** The projects it depends on that still have unfinished tasks. */
  waitingOn: string[]
  tasks: number
}

export interface FactoryState {
  settings: Settings
  loop: LoopState
  projects: ProjectInfo[]
  maxAgentCap: number
}

/** Sends a request with an optional JSON body and returns the parsed JSON answer; throws the server's error text. */
async function call<T>(method: 'POST' | 'DELETE', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(data?.error ?? `${method} ${url} → ${res.status}`)
  return data as T
}

const enc = encodeURIComponent

export function fetchFactory(): Promise<FactoryState> {
  return getJson('/api/factory') as Promise<FactoryState>
}

export function updateFactory(patch: Partial<Pick<Settings, 'defaultMode' | 'agentCap' | 'paused'>>): Promise<unknown> {
  return call('POST', '/api/factory', patch)
}

/** Sets a level's mode, or clears it (null) so the level inherits again. */
export function setMode(level: 'projects' | 'sessions' | 'tasks', id: string, mode: TaskMode | null): Promise<unknown> {
  return call('POST', `/api/${level}/${enc(id)}/mode`, { mode })
}

export function previewTaskDelete(id: string): Promise<DeletePreview> {
  return getJson(`/api/tasks/${enc(id)}/delete-preview`) as Promise<DeletePreview>
}

export function previewSessionDelete(adwId: string): Promise<DeletePreview[]> {
  return getJson(`/api/sessions/${enc(adwId)}/delete-preview`) as Promise<DeletePreview[]>
}

export function deleteTask(id: string): Promise<DeleteReport> {
  return call('DELETE', `/api/tasks/${enc(id)}`)
}

export function deleteSession(adwId: string): Promise<{ session: string; deleted: DeleteReport[] }> {
  return call('DELETE', `/api/sessions/${enc(adwId)}`)
}

export function completeTask(id: string): Promise<unknown> {
  return call('POST', `/api/tasks/${enc(id)}/complete`)
}

/** Un-parks a task the loop parked after a failure. */
export function retryTask(id: string): Promise<unknown> {
  return call('POST', `/api/tasks/${enc(id)}/retry`)
}

export function addDependency(id: string, dependency: string, reason: string): Promise<unknown> {
  return call('POST', `/api/tasks/${enc(id)}/dependencies`, { add: dependency, reason })
}

export function removeDependency(id: string, dependency: string): Promise<unknown> {
  return call('POST', `/api/tasks/${enc(id)}/dependencies`, { remove: dependency })
}

/** Makes the repository checked out at `path` a project. */
export function addProject(path: string): Promise<unknown> {
  return call('POST', '/api/projects', { path })
}

/** Removes a project from the factory, deleting every one of its tasks. */
export function deleteProject(name: string): Promise<unknown> {
  return call('DELETE', `/api/projects/${enc(name)}`)
}

export function setProjectDependsOn(name: string, dependsOn: string[]): Promise<unknown> {
  return call('POST', `/api/projects/${enc(name)}/depends-on`, { dependsOn })
}

export function setProjectPaused(name: string, paused: boolean): Promise<unknown> {
  return call('POST', `/api/projects/${enc(name)}/paused`, { paused })
}
