// Pure layout for the waterfall and the card mini-timelines: time in ms in, pixels out.
// One module so both views agree on how idle gaps collapse and how short runs stay readable.

export interface Interval {
  id: string
  start: number
  end: number
}

export interface TimelineOpts {
  /** Width the active time should fill. Layout may exceed it, never shrink below it. */
  trackPx: number
  /** Floor for every block; later blocks shift right to make room. */
  minBlockPx: number
  /** A gap between runs longer than this collapses into a break. */
  gapMs: number
  /** Fixed width of a collapsed break. */
  breakPx: number
  /** A gap shorter than this draws nothing: the blocks touch. Default 10 s. */
  touchMs?: number
  /** Fixed width of the spacer drawn for a gap between touchMs and gapMs. Default 12. */
  spacerPx?: number
}

export interface Placed {
  left: number
  width: number
}

export interface TimelineBreak extends Placed {
  skippedMs: number
}

export interface TimelineSpacer extends Placed {
  idleMs: number
}

export interface TimelineTick {
  px: number
  label: string
}

export interface Timeline {
  /** The track width, or more when blocks and breaks overflow it. */
  widthPx: number
  blocks: Record<string, Placed>
  breaks: TimelineBreak[]
  spacers: TimelineSpacer[]
  /** Monotonic. A time inside a break maps to the break's middle. */
  xAt: (t: number) => number
  ticks: TimelineTick[]
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const TICK_STEPS_MS = [
  1, 2, 5, 10, 15, 30, 60, 2 * 60, 5 * 60, 10 * 60, 15 * 60, 30 * 60, 3600, 2 * 3600, 3 * 3600,
  6 * 3600, 12 * 3600,
].map((s) => s * SECOND)
const MIN_TICK_GAP_PX = 120
const MAX_INNER_TICKS = 200
const DEFAULT_TOUCH_MS = 10 * SECOND
const DEFAULT_SPACER_PX = 12

/** "3:04 pm", or "3:04:12 pm" when the ruler resolves finer than a minute. */
export function clockLabel(t: number, withSeconds = false): string {
  const d = new Date(t)
  const h = d.getHours()
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = withSeconds ? `:${String(d.getSeconds()).padStart(2, '0')}` : ''
  return `${h % 12 || 12}:${mm}${ss} ${h < 12 ? 'am' : 'pm'}`
}

/** Idle time for a break label: "28m", "2h 02m". */
export function gapLabel(ms: number): string {
  const totalMin = Math.round(ms / MINUTE)
  if (totalMin < 60) return `${totalMin}m`
  return `${Math.floor(totalMin / 60)}h ${String(totalMin % 60).padStart(2, '0')}m`
}

/**
 * The px-per-ms at which the blocks' widths, each floored at minPx, add up to `avail`.
 * Zero when the floors alone already fill it.
 */
function fillScale(durations: number[], avail: number, minPx: number): number {
  let floored = new Set<number>()
  for (;;) {
    let flexMs = 0
    for (const [i, d] of durations.entries()) if (!floored.has(i)) flexMs += d
    const room = avail - floored.size * minPx
    if (flexMs <= 0 || room <= 0) return 0
    const scale = room / flexMs
    const next = new Set(floored)
    for (const [i, d] of durations.entries()) if (d * scale < minPx) next.add(i)
    if (next.size === floored.size) return scale
    floored = next
  }
}

export function layoutTimeline(intervals: Interval[], opts: TimelineOpts): Timeline {
  const { trackPx, minBlockPx, gapMs, breakPx } = opts
  const touchMs = opts.touchMs ?? DEFAULT_TOUCH_MS
  const spacerPx = opts.spacerPx ?? DEFAULT_SPACER_PX
  const items = intervals
    .map((i) => ({ id: i.id, start: i.start, end: Math.max(i.start, i.end) }))
    .toSorted((a, b) => a.start - b.start || a.end - b.end)

  if (!items.length) {
    return { widthPx: trackPx, blocks: {}, breaks: [], spacers: [], xAt: () => 0, ticks: [] }
  }

  // Gaps are drawn by duration class, never by the fill scale, so a short pause cannot
  // grow with the window. Overlapping runs stay sequential: a negative gap touches.
  const gaps: number[] = []
  let reach = items[0]!.end
  for (const item of items.slice(1)) {
    gaps.push(item.start - reach)
    reach = Math.max(reach, item.end)
  }
  const gapPx = (g: number) => (g > gapMs ? breakPx : g >= touchMs ? spacerPx : 0)
  const fixedPx = gaps.reduce((sum, g) => sum + gapPx(g), 0)
  const pxPerMs = fillScale(
    items.map((i) => i.end - i.start),
    Math.max(trackPx - fixedPx, 0),
    minBlockPx,
  )

  const blocks: Record<string, Placed> = {}
  const breaks: TimelineBreak[] = []
  const spacers: TimelineSpacer[] = []
  const breakSpans: { from: number; to: number; mid: number }[] = []
  const knots: { t: number; x: number }[] = []
  let x = 0
  let prevEnd = items[0]!.end

  for (const [idx, item] of items.entries()) {
    if (idx > 0) {
      const g = gaps[idx - 1]!
      const w = gapPx(g)
      if (g > gapMs) {
        breaks.push({ left: x, width: w, skippedMs: g })
        breakSpans.push({ from: prevEnd, to: item.start, mid: x + w / 2 })
      } else if (w > 0) {
        spacers.push({ left: x, width: w, idleMs: g })
      }
      x += w
    }
    const width = Math.max((item.end - item.start) * pxPerMs, minBlockPx)
    blocks[item.id] = { left: x, width }
    knots.push({ t: item.start, x }, { t: item.end, x: x + width })
    x += width
    prevEnd = Math.max(prevEnd, item.end)
  }

  knots.sort((a, b) => a.t - b.t || a.x - b.x)
  let floor = 0
  for (const kn of knots) {
    floor = Math.max(floor, kn.x)
    kn.x = floor
  }

  const xAt = (t: number): number => {
    const span = breakSpans.find((b) => t > b.from && t < b.to)
    if (span) return span.mid
    const first = knots[0]!
    const last = knots.at(-1)!
    if (t <= first.t) return first.x
    if (t >= last.t) return last.x
    let lo = 0
    let hi = knots.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (knots[mid]!.t < t) lo = mid
      else hi = mid
    }
    const a = knots[lo]!
    const b = knots[hi]!
    if (b.t === t) {
      let j = hi
      while (j > 0 && knots[j - 1]!.t === t) j--
      return knots[j]!.x
    }
    return b.t === a.t ? a.x : a.x + ((t - a.t) / (b.t - a.t)) * (b.x - a.x)
  }

  const widthPx = Math.max(trackPx, x)

  // Time is no longer linear across spacers and floored blocks, so labels are placed
  // greedily by priority and dropped when they would collide: a clock time at the start
  // of each stretch after a break, then each block start, then round times inside blocks.
  const step = pxPerMs > 0 ? (TICK_STEPS_MS.find((s) => s * pxPerMs >= MIN_TICK_GAP_PX) ?? 24 * HOUR) : SECOND
  const withSeconds = step < MINUTE
  const candidates: { px: number; t: number; rank: number }[] = []
  for (const [idx, item] of items.entries()) {
    const afterBreak = idx === 0 || gaps[idx - 1]! > gapMs
    const left = blocks[item.id]!.left
    candidates.push({ px: left, t: item.start, rank: afterBreak ? 0 : 1 })
    if (pxPerMs <= 0) continue
    const tz = new Date(item.start).getTimezoneOffset() * MINUTE
    let t = Math.ceil((item.start + 1 - tz) / step) * step + tz
    for (let n = 0; t < item.end && n < MAX_INNER_TICKS; n++, t += step) {
      candidates.push({ px: xAt(t), t, rank: 2 })
    }
  }
  const placed: typeof candidates = []
  for (const c of candidates.toSorted((a, b) => a.rank - b.rank || a.px - b.px)) {
    if (placed.some((p) => Math.abs(p.px - c.px) < MIN_TICK_GAP_PX)) continue
    if (c.rank === 2 && widthPx - c.px < MIN_TICK_GAP_PX) continue
    placed.push(c)
  }
  const ticks: TimelineTick[] = placed
    .toSorted((a, b) => a.px - b.px)
    .map((c) => ({ px: c.px, label: clockLabel(c.t, withSeconds) }))

  return { widthPx, blocks, breaks, spacers, xAt, ticks }
}
