<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch, watchEffect } from 'vue'
import type {
  AgentSession,
  AgentStartPayload,
  Envelope,
  EventRow,
  GateResult,
  LaneMeta,
  Need,
  OrderStatus,
  Phase,
  PhaseKind,
  Session,
  SessionUsage,
} from '../lib/types'
import { Bot, SquareTerminal, UserRound } from 'lucide-vue-next'
import { fetchEnvelopes, fetchEvents, fetchGates, fetchSession } from '../lib/api'
import { fmtDate, fmtDuration, payloadOk, ts } from '../lib/format'
import { modelIcon, modelName } from '../lib/models'
import { agentColor, argsSummary, parseAgentStart, parsePayload } from '../lib/events'
import { gapLabel, layoutTimeline, type Interval } from '../lib/timeline'
import { navigate, phaseCrumb } from '../lib/router'
import StatusChip from './StatusChip.vue'
import StatChip from './StatChip.vue'
import PhaseDetail from './PhaseDetail.vue'

const props = defineProps<{ adwId: string; phaseId: string | null }>()

const session = ref<Session | null>(null)
const phases = ref<Phase[]>([])
const agents = ref<AgentSession[]>([])
const usage = ref<SessionUsage>({ read: 0, written: 0 })
const events = ref<EventRow[]>([])
const envelopes = ref<Envelope[]>([])
const gates = ref<GateResult[]>([])
const laneMeta = ref<Record<string, LaneMeta>>({})
const loopStops = ref<Set<string>>(new Set())
const needs = ref<Need[]>([])
const orderStatus = ref<OrderStatus>('waiting')
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())

let cursor = 0
let inflight = false
let timer: ReturnType<typeof setInterval> | undefined

const SIDE_TABLE_TYPES = new Set(['gate_pass', 'gate_fail', 'handoff', 'agent_end', 'phase_end', 'error'])

async function tick() {
  if (inflight) return
  inflight = true
  try {
    const detail = await fetchSession(props.adwId)
    session.value = detail.session
    phases.value = detail.phases.toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    agents.value = detail.agents
    usage.value = detail.usage
    laneMeta.value = detail.lane_meta
    loopStops.value = new Set(detail.loop_stops ?? [])
    needs.value = detail.needs
    orderStatus.value = detail.order_status

    const fresh: EventRow[] = []
    let page
    do {
      // Cursor pagination is inherently sequential: each request needs the previous cursor.
      // oxlint-disable-next-line no-await-in-loop
      page = await fetchEvents(props.adwId, cursor, 1000)
      cursor = Math.max(cursor, page.cursor)
      fresh.push(...page.events)
    } while (page.has_more)
    if (fresh.length) events.value = [...events.value, ...fresh]

    // Envelopes only gain rows around phase/agent boundaries. Gates are refetched
    // every tick: a checklist's CI item changes with no new event.
    const needEnvelopes =
      !loaded.value || fresh.some((e) => e.type !== null && SIDE_TABLE_TYPES.has(e.type))
    const [env, g] = await Promise.all([
      needEnvelopes ? fetchEnvelopes(props.adwId) : null,
      fetchGates(props.adwId),
    ])
    if (env) envelopes.value = env
    gates.value = g

    nowMs.value = Date.now()
    apiError.value = null
    loaded.value = true
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
  } finally {
    inflight = false
  }
}

onMounted(() => {
  void tick()
  timer = setInterval(() => void tick(), 500)
})

onUnmounted(() => {
  clearInterval(timer)
  clearTimeout(highlightTimer)
  resizeObserver?.disconnect()
  phaseCrumb.value = null
})

const selectedPhase = computed(
  () => phases.value.find((p) => p.phase_id === props.phaseId) ?? null,
)

watchEffect(() => {
  phaseCrumb.value = selectedPhase.value?.name ?? null
})

// ── Lanes ────────────────────────────────────────────────────────────────────

const YOU_COLOR = 'var(--amber)'
const CODE_COLOR = 'var(--cyan)'

const KIND_ICONS = { engineer: UserRound, code: SquareTerminal, agent: Bot }

interface Lane {
  id: string
  label: string
  /** Model driving this lane's agent — rendered with its provider icon. */
  model: string | null
  /** Context-window occupancy, or null while unknown (running / old db). */
  context: LaneContext | null
  metaLines: string[]
  color: string
  kind: PhaseKind
  phases: Phase[]
}

interface LaneContext {
  used: number
  window: number
  /** 0–100, uncapped by the floor applied to the bar's width. */
  pct: number
}

/** Occupancy for an agent lane. Null unless BOTH numbers are real — a bar
 *  against an unknown ceiling would be decoration, not data. */
function laneContext(info: AgentSession | undefined): LaneContext | null {
  const used = info?.context_tokens ?? 0
  const window = info?.context_window ?? 0
  if (!used || !window) return null
  return { used, window, pct: Math.min(100, (used / window) * 100) }
}

/** Sub-1% occupancy is common and real; round it away and the bar reads empty. */
function contextLabel(ctx: LaneContext): string {
  return ctx.pct < 1 ? `${ctx.pct.toFixed(1)}%` : `${Math.round(ctx.pct)}%`
}

/** Keep a non-zero fill visible — the exact numbers ride in the label and title. */
function contextFill(ctx: LaneContext): string {
  return `${Math.max(ctx.pct, 2)}%`
}

const NUM = new Intl.NumberFormat('en-US')

// A live agent's model/thinking/color arrive on its agent_start event before
// any agent_sessions row exists; attribute each start to its phase's owner.
const ownerStart = computed<Record<string, AgentStartPayload>>(() => {
  const ownerByPhase = new Map<string, string | null>(
    phases.value.map((p) => [p.phase_id, p.owner]),
  )
  const meta: Record<string, AgentStartPayload> = {}
  for (const e of events.value) {
    if (e.type !== 'agent_start') continue
    const owner = (e.phase_id ? ownerByPhase.get(e.phase_id) : null) ?? e.name
    if (!owner || meta[owner]) continue
    const payload = parseAgentStart(e)
    if (payload) meta[owner] = payload
  }
  return meta
})

const YOU_LANE = 'you'

const lanes = computed<Lane[]>(() => {
  const ph = phases.value
  const agentOwners: string[] = []
  for (const p of ph) {
    if (p.kind === 'agent' && p.owner && !agentOwners.includes(p.owner)) agentOwners.push(p.owner)
  }
  const codePhases = ph.filter((p) => p.kind === 'code')
  const out: Lane[] = [
    {
      id: YOU_LANE,
      label: 'You',
      model: null,
      context: null,
      metaLines: ['needs you'],
      color: YOU_COLOR,
      kind: 'engineer' as const,
      phases: ph.filter((p) => p.kind === 'engineer'),
    },
  ]
  if (codePhases.length) {
    out.push({
      id: 'code',
      label: 'code',
      model: null,
      context: null,
      metaLines: ['workspace'],
      color: CODE_COLOR,
      kind: 'code' as const,
      phases: codePhases,
    })
  }
  for (const [i, owner] of agentOwners.entries()) {
    const info = agents.value.find((a) => a.agent === owner)
    const start = ownerStart.value[owner]
    out.push({
      id: `agent:${owner}`,
      label: laneMeta.value[owner]?.title ?? owner,
      // The model is the lane's whole story; thinking level lives in the
      // phase detail's agent config section.
      model: info?.model ?? start?.model ?? null,
      context: laneContext(info),
      metaLines: laneMeta.value[owner]?.subtitle ? [laneMeta.value[owner].subtitle] : [],
      color: agentColor(info?.color, start?.color, i),
      kind: 'agent' as const,
      phases: ph.filter((p) => p.kind === 'agent' && p.owner === owner),
    })
  }
  return out
})

// ── Timeline geometry ────────────────────────────────────────────────────────

const LABEL_PX = 280
const PAD = 10
const MIN_BLOCK_PX = 160
const BREAK_PX = 84
const GAP_MS = 5 * 60_000
const BLOCK_GAP_PX = 8
// A queued block must stay readable too, so the layout leaves it this much room past the last run.
const QUEUED_RESERVE_PX = MIN_BLOCK_PX + 2 * BLOCK_GAP_PX

const queuedByLane = computed(() => {
  const map: Record<string, Phase[]> = {}
  for (const lane of lanes.value) {
    map[lane.id] = lane.phases.filter((p) => !p.started_at)
  }
  return map
})

const scroller = useTemplateRef<HTMLElement>('scroller')
const visiblePx = ref(1000)
let resizeObserver: ResizeObserver | undefined

watch(scroller, (el) => {
  resizeObserver?.disconnect()
  if (!el) return
  const measure = () => (visiblePx.value = Math.max(el.clientWidth - LABEL_PX, 0))
  measure()
  resizeObserver = new ResizeObserver(measure)
  resizeObserver.observe(el)
})

const intervals = computed<Interval[]>(() =>
  phases.value.flatMap((p) => {
    const start = ts(p.started_at)
    if (!Number.isFinite(start)) return []
    let end = ts(p.ended_at)
    if (!Number.isFinite(end)) end = p.status === 'running' ? nowMs.value : start
    return [{ id: p.phase_id, start, end }]
  }),
)

const reservePx = computed(() =>
  Object.values(queuedByLane.value).some((q) => q.length > 0) ? QUEUED_RESERVE_PX : 0,
)

const timeline = computed(() =>
  layoutTimeline(intervals.value, {
    trackPx: Math.max(visiblePx.value - 2 * PAD - reservePx.value, 0),
    minBlockPx: MIN_BLOCK_PX,
    gapMs: GAP_MS,
    breakPx: BREAK_PX,
  }),
)

/** Track width: the visible width, or more when blocks overflow it and the view scrolls. */
const trackPx = computed(() =>
  Math.max(visiblePx.value, timeline.value.widthPx + 2 * PAD + reservePx.value),
)

const px = (x: number) => `${x + PAD}px`

function blockStyle(p: Phase): Record<string, string> | undefined {
  const geom = timeline.value.blocks[p.phase_id]
  if (!geom) return undefined
  return { left: px(geom.left), width: `${geom.width}px` }
}

function blockDurationMs(p: Phase): number {
  const start = ts(p.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = p.status === 'running' ? nowMs.value : ts(p.ended_at)
  if (!Number.isFinite(end)) return NaN
  return end - start
}

const STATUS_GLYPH: Record<string, string> = {
  success: '✓',
  fail: '✗',
  skipped: '⊘',
  running: '●',
  queued: '○',
}

// Tool-call tick marks inside a phase block, positioned within the block's own span.
interface ToolTick {
  t: number
  ok: boolean
  title: string
  command: string
}

const toolTicks = computed(() => {
  const map: Record<string, ToolTick[]> = {}
  for (const e of events.value) {
    if (e.type !== 'tool_call' || !e.phase_id) continue
    const payload = parsePayload(e.payload_json)
    const args = payload?.args as Record<string, unknown> | undefined
    const command = typeof args?.command === 'string' ? args.command : argsSummary(args)
    map[e.phase_id] ??= []
    map[e.phase_id]?.push({
      t: ts(e.started_at),
      ok: payloadOk(e.payload_json),
      title: typeof payload?.title === 'string' ? payload.title : (e.name ?? 'tool call'),
      command,
    })
  }
  return map
})

function ticksFor(p: Phase): (ToolTick & { x: number })[] {
  const start = ts(p.started_at)
  if (!Number.isFinite(start)) return []
  let end = ts(p.ended_at)
  if (!Number.isFinite(end)) end = p.status === 'running' ? nowMs.value : start
  const width = Math.max(end - start, 1)
  return (toolTicks.value[p.phase_id] ?? [])
    .filter((mark) => Number.isFinite(mark.t))
    .map((mark) => {
      const x = Math.min(Math.max(((mark.t - start) / width) * 100, 1), 99)
      return { t: mark.t, ok: mark.ok, title: mark.title, command: mark.command, x }
    })
}

/** A queued block spans the free part of its lane: from its last block (or the track start) to the right edge. */
function queuedStyle(lane: Lane): Record<string, string> {
  let end = 0
  for (const p of lane.phases) {
    const g = timeline.value.blocks[p.phase_id]
    if (g) end = Math.max(end, g.left + g.width)
  }
  const left = PAD + (end > 0 ? end + BLOCK_GAP_PX : 0)
  return { left: `${left}px`, width: `${trackPx.value - left - PAD}px` }
}

// Only a cook the loop itself recorded as failed or skipped stopped it; a run outside the loop never did.
function stoppedCook(p: Phase): boolean {
  return loopStops.value.has(p.phase_id)
}

const STOP_LABEL_PX = 170

function loopStopped(p: Phase, lane: Lane): { left: string; flip: boolean; label: boolean } | null {
  const g = timeline.value.blocks[p.phase_id]
  if (!stoppedCook(p) || !g) return null
  const right = g.left + g.width
  // Back-to-back stops in a lane would stack their labels; only the last one is spelled out.
  const crowded = lane.phases.some((q) => {
    const h = timeline.value.blocks[q.phase_id]
    return q !== p && stoppedCook(q) && h !== undefined && h.left > g.left && h.left - right < STOP_LABEL_PX
  })
  const edge = right + 2
  return { left: px(edge), flip: edge > timeline.value.widthPx - STOP_LABEL_PX, label: !crowded }
}

const sessionDurationMs = computed(() => {
  const s = session.value
  if (!s) return NaN
  const start = ts(s.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = s.status === 'running' ? nowMs.value : ts(s.ended_at)
  return (Number.isFinite(end) ? end : nowMs.value) - start
})

// ── "You" lane: one dot per need ─────────────────────────────────────────────

const NEED_SLOT_PX = 22

const needDots = computed(() => {
  const { blocks, widthPx, xAt } = timeline.value
  const seen = new Map<number, number>()
  return needs.value.map((need) => {
    const geom = need.phaseId ? blocks[need.phaseId] : undefined
    const raised = ts(need.raisedAt)
    let x = geom ? geom.left + geom.width : Number.isFinite(raised) ? xAt(raised) : widthPx
    x = Math.min(Math.max(x, 12), Math.max(widthPx - 12, 12))
    // Needs anchored to the same spot fan out sideways instead of stacking.
    const key = Math.round(x / 4)
    const slot = seen.get(key) ?? 0
    seen.set(key, slot + 1)
    return { need, left: `${PAD + x + slot * NEED_SLOT_PX}px` }
  })
})

// ── Highlight: a clicked dot scrolls to and lights up its block. Clicking a block always opens its run panel. ──

const HIGHLIGHT_MS = 6000
const highlight = ref<{ phaseId: string } | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | undefined
const root = useTemplateRef<HTMLElement>('root')

function followGoTo(goTo: Need['goTo']) {
  if (goTo.kind === 'pr') window.open(goTo.url, '_blank', 'noopener')
  else navigate(props.adwId, goTo.phaseId)
}

async function onDotClick(need: Need) {
  const anchor = need.phaseId ? phases.value.find((p) => p.phase_id === need.phaseId) : undefined
  if (!need.phaseId || !anchor) {
    followGoTo(need.goTo)
    return
  }
  const phaseId = need.phaseId
  highlight.value = { phaseId }
  clearTimeout(highlightTimer)
  highlightTimer = setTimeout(() => (highlight.value = null), HIGHLIGHT_MS)
  await nextTick()
  const el = [...(root.value?.querySelectorAll<HTMLElement>('[data-phase]') ?? [])].find(
    (n) => n.dataset.phase === phaseId,
  )
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// Bumped on every block click, so the panel re-applies its focus even when that block's panel is already open.
const focusSeq = ref(0)

// A block click always opens its run panel and never closes it (the panel's ✕ does that).
function onBlockClick(p: Phase) {
  highlight.value = null
  clearTimeout(highlightTimer)
  focusSeq.value += 1
  if (p.phase_id !== props.phaseId) navigate(props.adwId, p.phase_id)
}

// What the open panel focuses: the kind of the newest open need anchored to its block, if any.
const focusKind = computed<Need['kind'] | null>(() => {
  const id = props.phaseId
  if (!id) return null
  const open = needs.value.filter((n) => n.phaseId === id && n.resolvedAt === null)
  return open.toSorted((a, b) => a.raisedAt.localeCompare(b.raisedAt)).at(-1)?.kind ?? null
})

// ── Hover tooltip (fixed-position: the tracks clip their overflow) ───────────

type Tip =
  | { kind: 'block'; x: number; y: number; name: string; status: string; description: string }
  | { kind: 'tick'; x: number; y: number; title: string; command: string; ok: boolean }
  | { kind: 'need'; x: number; y: number; need: Need }
  | { kind: 'idle'; x: number; y: number; idleMs: number }

type TipBody = DistributiveOmit<Tip, 'x' | 'y'>
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

const tip = ref<Tip | null>(null)

function showTip(e: MouseEvent, body: TipBody) {
  tip.value = {
    ...body,
    x: Math.max(8, Math.min(e.clientX + 14, window.innerWidth - 420)),
    y: Math.min(e.clientY + 18, window.innerHeight - 160),
  } as Tip
}

function hideTip() {
  tip.value = null
}

function blockTip(e: MouseEvent, p: Phase) {
  // Ticks sit inside the block's <button>, so one handler picks which tooltip applies.
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tick]')
  const mark = el ? ticksFor(p)[Number(el.dataset.tick)] : undefined
  if (mark) {
    showTip(e, { kind: 'tick', title: mark.title, command: mark.command, ok: mark.ok })
  } else {
    showTip(e, {
      kind: 'block',
      name: p.name ?? '',
      status: p.status ?? '',
      description: p.description ?? '',
    })
  }
}

</script>

<template>
  <div ref="root" class="trace">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div v-if="session" class="run-strip">
      <span class="request" :title="session.request ?? ''">{{ session.request }}</span>
      <StatusChip :status="orderStatus" />
      <span class="dim">started {{ fmtDate(session.started_at) }}</span>
      <span class="run-stats">
        <StatChip v-if="session.total_cost != null" kind="cost" :value="session.total_cost" />
        <StatChip kind="runtime" :value="sessionDurationMs" />
        <StatChip kind="tokens" :value="session.total_tokens" />
        <StatChip kind="read" :value="usage.read" />
        <StatChip kind="written" :value="usage.written" />
      </span>
    </div>

    <div v-if="phases.length" class="waterfall">
      <div ref="scroller" class="scroller">
        <div class="canvas" :style="{ '--track-w': `${trackPx}px` }">
          <div class="row axis-row">
            <div class="label" />
            <div class="track">
              <span
                v-for="(t, i) in timeline.ticks"
                :key="`t${i}`"
                class="axis-label"
                :style="{ left: px(t.px) }"
                >{{ t.label }}</span
              >
              <span
                v-for="(b, i) in timeline.breaks"
                :key="`b${i}`"
                class="break-label"
                :style="{ left: px(b.left), width: `${b.width}px` }"
                :title="`${gapLabel(b.skippedMs)} with no runs, collapsed`"
                >⋯ {{ gapLabel(b.skippedMs) }}</span
              >
            </div>
          </div>

          <div
            v-for="lane in lanes"
            :key="lane.id"
            class="row lane"
            :class="[`kind-${lane.kind}`, { you: lane.id === YOU_LANE }]"
          >
            <div class="label">
              <span class="lane-name" :style="{ color: lane.color }">
                <component :is="KIND_ICONS[lane.kind]" class="lane-icon" :size="22" :stroke-width="2" />
                {{ lane.label }}
              </span>
              <span v-if="lane.model" class="lane-meta lane-model" :title="lane.model">
                <img v-if="modelIcon(lane.model)" class="model-icon" :src="modelIcon(lane.model)!" alt="" />
                {{ modelName(lane.model) }}
              </span>
              <span
                v-if="lane.context"
                class="lane-ctx"
                :title="`${NUM.format(lane.context.used)} / ${NUM.format(lane.context.window)} tokens used · ${NUM.format(lane.context.window - lane.context.used)} remaining`"
              >
                <span class="ctx-head">
                  <span class="ctx-label">Context</span>
                  <span class="ctx-pct">{{ contextLabel(lane.context) }}</span>
                </span>
                <span class="ctx-bar">
                  <span
                    class="ctx-fill"
                    :style="{ width: contextFill(lane.context), background: lane.color }"
                  />
                </span>
              </span>
              <span v-for="(line, i) in lane.metaLines" :key="i" class="lane-meta">{{ line }}</span>
            </div>
            <div class="track">
              <span
                v-for="(b, i) in timeline.breaks"
                :key="`b${i}`"
                class="break-col"
                :style="{ left: px(b.left), width: `${b.width}px` }"
              />
              <span
                v-for="(sp, i) in timeline.spacers"
                :key="`s${i}`"
                class="spacer-mark"
                :style="{ left: px(sp.left), width: `${sp.width}px` }"
                @mouseenter="showTip($event, { kind: 'idle', idleMs: sp.idleMs })"
                @mousemove="showTip($event, { kind: 'idle', idleMs: sp.idleMs })"
                @mouseleave="hideTip"
              />
              <span
                v-for="(t, i) in timeline.ticks"
                :key="i"
                class="gridline"
                :style="{ left: px(t.px) }"
              />
              <button
                v-for="d in lane.id === YOU_LANE ? needDots : []"
                :key="d.need.id"
                class="need-dot"
                :class="[d.need.resolvedAt ? 'resolved' : d.need.severity]"
                :style="{ left: d.left }"
                :aria-label="d.need.title"
                @mouseenter="showTip($event, { kind: 'need', need: d.need })"
                @mousemove="showTip($event, { kind: 'need', need: d.need })"
                @mouseleave="hideTip"
                @click="onDotClick(d.need)"
              />
              <template v-for="p in lane.phases" :key="p.phase_id">
                <button
                  v-if="timeline.blocks[p.phase_id]"
                  class="block"
                  :class="[p.status, { selected: p.phase_id === phaseId, hl: p.phase_id === highlight?.phaseId }]"
                  :style="blockStyle(p)"
                  :data-phase="p.phase_id"
                  @mousemove="blockTip($event, p)"
                  @mouseleave="hideTip"
                  @click="onBlockClick(p)"
                >
                  <span class="b-top">
                    <span class="b-status" :class="p.status">{{
                      STATUS_GLYPH[p.status ?? ''] ?? '○'
                    }}</span>
                    <span class="b-name">{{ p.name }}</span>
                  </span>
                  <span class="b-meta">
                    <StatChip
                      v-if="Number.isFinite(blockDurationMs(p))"
                      class="b-dur"
                      kind="runtime"
                      compact
                      :value="blockDurationMs(p)"
                    />
                    <span class="b-desc">{{ p.description }}</span>
                  </span>
                  <span
                    v-for="(mark, i) in ticksFor(p)"
                    :key="i"
                    class="tool-tick"
                    :class="{ err: !mark.ok }"
                    :data-tick="i"
                    :style="{ left: `${mark.x}%` }"
                  />
                </button>
                <span
                  v-if="loopStopped(p, lane)"
                  class="stop-mark"
                  :class="{ flip: loopStopped(p, lane)?.flip }"
                  :style="{ left: loopStopped(p, lane)?.left }"
                  ><span v-if="loopStopped(p, lane)?.label" class="stop-label"
                    >loop stopped here</span
                  ></span
                >
              </template>
              <button
                v-for="p in queuedByLane[lane.id]"
                :key="p.phase_id"
                class="block queued"
                :class="{ selected: p.phase_id === phaseId, hl: p.phase_id === highlight?.phaseId }"
                :style="queuedStyle(lane)"
                :data-phase="p.phase_id"
                @mousemove="blockTip($event, p)"
                @mouseleave="hideTip"
                @click="onBlockClick(p)"
              >
                <span class="b-top">
                  <span class="b-status queued">○</span>
                  <span class="b-name">{{ p.name }}</span>
                </span>
                <span class="b-meta">
                  <span class="b-desc">{{ p.description ?? 'queued' }}</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="loaded" class="empty-state">no phases recorded for this session</div>
    <div v-else-if="!apiError" class="empty-state">loading trace…</div>

    <div
      v-if="tip"
      class="tip"
      :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
      role="tooltip"
    >
      <template v-if="tip.kind === 'tick'">
        <div class="tip-title">{{ tip.title }}</div>
        <div v-if="tip.command" class="tip-cmd">{{ tip.command }}</div>
        <div :class="tip.ok ? 'tip-ok' : 'tip-fail'">{{ tip.ok ? 'ok' : 'failed' }}</div>
      </template>
      <template v-else-if="tip.kind === 'need'">
        <div class="tip-title">{{ tip.need.title }}</div>
        <div class="tip-desc">{{ tip.need.description }}</div>
        <div class="tip-meta">raised {{ fmtDate(tip.need.raisedAt) }}</div>
        <div v-if="tip.need.resolvedAt" class="tip-meta">
          resolved {{ fmtDate(tip.need.resolvedAt) }}
        </div>
      </template>
      <template v-else-if="tip.kind === 'idle'">
        <div class="tip-title">idle {{ fmtDuration(tip.idleMs) }}</div>
      </template>
      <template v-else>
        <div class="tip-title">{{ tip.name }} — {{ tip.status }}</div>
        <div v-if="tip.description" class="tip-desc">{{ tip.description }}</div>
      </template>
    </div>

    <PhaseDetail
      v-if="selectedPhase"
      :phase="selectedPhase"
      :events="events"
      :envelopes="envelopes"
      :gates="gates"
      :pr="laneMeta[selectedPhase.owner ?? '']?.pr ?? null"
      :focus-kind="focusKind"
      :focus-seq="focusSeq"
      @close="navigate(props.adwId)"
    />
  </div>
</template>

<style scoped>
.trace {
  padding: 0 0 40px;
}

.run-strip {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 14px 24px;
  border-bottom: 1px solid var(--border-soft);
  flex-wrap: wrap;
}

.run-strip .request {
  font-size: 17px;
  color: var(--text);
  max-width: 52ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-stats {
  display: inline-flex;
  gap: 12px;
  flex-wrap: wrap;
}

.waterfall {
  margin: 20px 28px;
  border: 1px solid var(--border-soft);
  border-radius: 16px;
  background: var(--panel);
  overflow: hidden;
}

/* The ruler and every lane scroll together; only the label column stays put. */
.scroller {
  overflow-x: auto;
  scroll-padding-left: 280px;
}

.canvas {
  width: calc(280px + var(--track-w));
  min-width: 100%;
}

.row {
  display: grid;
  grid-template-columns: 280px 1fr;
}

.axis-row {
  border-bottom: 1px solid var(--border);
  background: var(--panel-2);
}

.axis-row .label {
  background: var(--panel-2);
}

.axis-row .track {
  height: 40px;
}

.axis-label {
  position: absolute;
  bottom: 7px;
  padding-left: 6px;
  font-family: var(--mono);
  font-size: 16px;
  color: var(--dim);
  white-space: nowrap;
}

.break-label {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 16px;
  color: var(--faint);
  white-space: nowrap;
}

.label {
  position: sticky;
  left: 0;
  z-index: 4;
  background: var(--panel);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  border-right: 1px solid var(--border);
  overflow: hidden;
  white-space: nowrap;
}

.lane-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 17px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lane-icon {
  flex: none;
  opacity: 0.85;
}

.lane-meta {
  font-family: var(--mono);
  font-size: 16px;
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
}

.lane-model {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.model-icon {
  width: 17px;
  height: 17px;
  flex: none;
  object-fit: contain;
}

/* Context occupancy — label row over a thin track, under the model. */
.lane-ctx {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
  max-width: 190px;
}

.ctx-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.ctx-label {
  font-size: 14px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--faint);
}

.ctx-pct {
  font-family: var(--mono);
  font-size: 14px;
  color: var(--dim);
}

.ctx-bar {
  height: 6px;
  border-radius: 999px;
  background: var(--panel-3);
  border: 1px solid var(--border-soft);
  overflow: hidden;
}

.ctx-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  transition: width 300ms ease;
}

.lane {
  border-bottom: 1px solid var(--border-soft);
}

.lane:last-child {
  border-bottom: none;
}

.track {
  position: relative;
  height: 118px;
}

.gridline {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px dashed var(--border);
}

/* A short real pause: a fixed-width dashed mark, full lane height so it is easy to hover. */
.spacer-mark {
  position: absolute;
  top: 0;
  bottom: 0;
}

.spacer-mark::before {
  content: '';
  position: absolute;
  left: 1px;
  right: 1px;
  top: 50%;
  border-top: 1px dashed var(--faint);
  opacity: 0.7;
}

/* A collapsed idle gap: striped so it never reads as time to scale. */
.break-col {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px dashed var(--border);
  border-right: 1px dashed var(--border);
  background: repeating-linear-gradient(
    135deg,
    transparent 0 7px,
    color-mix(in srgb, var(--faint) 16%, transparent) 7px 9px
  );
}

.block {
  position: absolute;
  top: 13px;
  height: 92px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 4px;
  padding: 10px 12px 16px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  font-size: 16px;
  color: var(--text);
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  text-align: left;
  transition: background 0.16s ease;
}

.block:hover {
  background: var(--panel-hover);
}

/* Outline shows how the run went; the lane only colors its name. */
.block.success {
  border-color: var(--green-line);
}

.block.fail {
  border-color: var(--red-line);
}

.block.skipped {
  border-color: var(--amber-line);
}

.block.running {
  border-color: var(--blue-line);
}

/* Name on its own line, duration and summary on the next: the name and duration
   never share a row, so they stay whole at the 160px floor. */
.b-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.b-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.b-status {
  flex: none;
  font-size: 16px;
}

.b-status.success {
  color: var(--green);
}

.b-status.fail {
  color: var(--red);
}

.b-status.running {
  color: var(--blue);
  animation: pulse 1.2s ease-in-out infinite;
}

.b-status.skipped {
  color: var(--amber);
}

.b-status.queued {
  color: var(--faint);
}

.block .b-name {
  font-size: 17px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
}

.block .b-dur {
  flex: none;
}

.block .b-desc {
  color: var(--dim);
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.block.running {
  animation: pulse 1.6s ease-in-out infinite;
}

.block.queued {
  background: transparent;
  border-style: dashed;
  border-color: var(--faint);
  color: var(--dim);
}

.block.hl {
  outline: 3px solid var(--amber);
  outline-offset: 2px;
  animation: hl-pulse 0.9s ease-in-out infinite;
}

@keyframes hl-pulse {
  0%,
  100% {
    outline-color: var(--amber);
  }
  50% {
    outline-color: color-mix(in srgb, var(--amber) 25%, transparent);
  }
}

.block.selected {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

/* A wide transparent hit area around a 3px line, so hovering a tick is easy. */
.tool-tick {
  position: absolute;
  bottom: 0;
  width: 11px;
  height: 20px;
  margin-left: -5px;
  cursor: help;
}

.tool-tick::after {
  content: '';
  position: absolute;
  left: 4px;
  bottom: 4px;
  width: 3px;
  height: 9px;
  background: currentColor;
  opacity: 0.55;
  border-radius: 1px;
}

.tool-tick:hover::after {
  opacity: 1;
}

.tool-tick.err::after {
  background: var(--red);
  opacity: 1;
}

.lane.you .track {
  height: 64px;
}

.need-dot {
  position: absolute;
  top: 50%;
  width: 20px;
  height: 20px;
  padding: 0;
  border-radius: 50%;
  border: 2px solid var(--panel);
  transform: translate(-50%, -50%);
  cursor: pointer;
}

.need-dot.review {
  background: var(--amber);
}

.need-dot.broken {
  background: var(--red);
}

.need-dot.resolved {
  background: var(--faint);
  opacity: 0.4;
}

.need-dot:hover {
  transform: translate(-50%, -50%) scale(1.2);
}

.stop-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 2px solid var(--red);
  pointer-events: none;
  z-index: 2;
}

.stop-label {
  position: absolute;
  top: 2px;
  left: 4px;
  padding: 0 7px;
  border: 1px solid var(--red-line);
  border-radius: 6px;
  background: color-mix(in srgb, var(--red) 14%, var(--panel));
  color: var(--red);
  font-size: 16px;
  line-height: 1.3;
  white-space: nowrap;
}

.stop-mark.flip .stop-label {
  left: auto;
  right: 4px;
}

.tip {
  position: fixed;
  z-index: 50;
  max-width: 400px;
  padding: 9px 13px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel-2);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  pointer-events: none;
  font-size: 16px;
}

.tip-title {
  font-weight: 700;
  color: var(--text);
}

.tip-desc {
  color: var(--dim);
}

.tip-meta {
  color: var(--faint);
}

.tip-cmd {
  font-family: var(--mono);
  color: var(--cyan);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 7em;
  overflow: hidden;
}

.tip-ok {
  color: var(--green);
}

.tip-fail {
  color: var(--red);
}
</style>
