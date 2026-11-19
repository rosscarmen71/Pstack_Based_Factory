import { describe, expect, test } from 'bun:test'
import { clockLabel, gapLabel, layoutTimeline, type Interval, type TimelineOpts } from './timeline'

const SEC = 1000
const MIN = 60 * SEC
const T0 = new Date(2026, 10, 18, 15, 4, 0).getTime()

const OPTS: TimelineOpts = { trackPx: 686, minBlockPx: 160, gapMs: 5 * MIN, breakPx: 84 }

function run(id: string, startMs: number, durMs: number): Interval {
  return { id, start: T0 + startMs, end: T0 + startMs + durMs }
}

describe('layoutTimeline', () => {
  test('a 0.3 s run is still drawn at least minBlockPx wide', () => {
    const tl = layoutTimeline([run('a', 0, 300), run('b', 10 * SEC, 60 * SEC)], OPTS)
    expect(tl.blocks.a!.width).toBeGreaterThanOrEqual(160)
    expect(tl.blocks.b!.width).toBeGreaterThanOrEqual(160)
  })

  test('a long run grows in proportion to its time', () => {
    const tl = layoutTimeline([run('short', 0, 10 * SEC), run('long', 20 * SEC, 4 * MIN)], OPTS)
    expect(tl.blocks.long!.width).toBeGreaterThan(tl.blocks.short!.width * 2)
  })

  test('a 28-minute gap collapses into one break labelled with the skipped time', () => {
    const tl = layoutTimeline([run('a', 0, 2 * MIN), run('b', 30 * MIN, 2 * MIN)], OPTS)
    expect(tl.breaks).toHaveLength(1)
    expect(tl.breaks[0]!.skippedMs).toBe(28 * MIN)
    expect(tl.breaks[0]!.width).toBe(84)
    expect(gapLabel(tl.breaks[0]!.skippedMs)).toBe('28m')
    expect(tl.blocks.b!.left).toBeGreaterThanOrEqual(tl.blocks.a!.left + tl.blocks.a!.width + 84)
  })

  test('a 2-minute gap is a fixed 12 px spacer carrying its idle time, not a break', () => {
    const tl = layoutTimeline([run('a', 0, 20 * MIN), run('b', 22 * MIN, 20 * MIN)], OPTS)
    expect(tl.breaks).toHaveLength(0)
    expect(tl.spacers).toHaveLength(1)
    expect(tl.spacers[0]!.idleMs).toBe(2 * MIN)
    expect(tl.blocks.b!.left - (tl.blocks.a!.left + tl.blocks.a!.width)).toBeCloseTo(12, 5)
  })

  test('idle hours are labelled in hours and minutes', () => {
    expect(gapLabel(2 * 60 * MIN + 2 * MIN)).toBe('2h 02m')
  })

  test('five minimum-width blocks overflow the track instead of shrinking', () => {
    const runs = [0, 1, 2, 3, 4].map((i) => run(`r${i}`, i * 2 * SEC, SEC))
    const tl = layoutTimeline(runs, OPTS)
    expect(tl.widthPx).toBeGreaterThan(686)
    for (const id of ['r0', 'r1', 'r2', 'r3', 'r4']) {
      expect(tl.blocks[id]!.width).toBeGreaterThanOrEqual(160)
    }
  })

  test('blocks never stack: each starts at or after the previous one ends', () => {
    const runs = [0, 1, 2, 3].map((i) => run(`r${i}`, i * SEC, 500))
    const tl = layoutTimeline(runs, OPTS)
    const placed = ['r0', 'r1', 'r2', 'r3'].map((id) => tl.blocks[id]!)
    for (let i = 1; i < placed.length; i++) {
      expect(placed[i]!.left).toBeGreaterThanOrEqual(placed[i - 1]!.left + placed[i - 1]!.width)
    }
  })

  test('active time fills the track when nothing needs widening', () => {
    const tl = layoutTimeline([run('a', 0, 10 * MIN)], OPTS)
    expect(tl.widthPx).toBeCloseTo(686, 5)
    expect(tl.blocks.a!.left).toBe(0)
    expect(tl.blocks.a!.width).toBeCloseTo(686, 5)
  })

  test('xAt never goes backwards, across widened blocks and breaks', () => {
    const tl = layoutTimeline(
      [run('a', 0, 300), run('b', 5 * SEC, 4 * SEC), run('c', 40 * MIN, 3 * MIN), run('d', 40 * MIN + 190 * SEC, 200)],
      OPTS,
    )
    let prev = -Infinity
    for (let t = T0 - 10 * SEC; t <= T0 + 45 * MIN; t += 2 * SEC) {
      const x = tl.xAt(t)
      expect(x).toBeGreaterThanOrEqual(prev)
      prev = x
    }
  })

  test('xAt maps a time inside a break to the break middle', () => {
    const tl = layoutTimeline([run('a', 0, 2 * MIN), run('b', 30 * MIN, 2 * MIN)], OPTS)
    const br = tl.breaks[0]!
    expect(tl.xAt(T0 + 15 * MIN)).toBeCloseTo(br.left + br.width / 2, 5)
  })

  test('xAt lands a time inside a block within that block', () => {
    const tl = layoutTimeline([run('a', 0, 300), run('b', 5 * SEC, 4 * SEC)], OPTS)
    const x = tl.xAt(T0 + 5 * SEC + 2 * SEC)
    const b = tl.blocks.b!
    expect(x).toBeGreaterThanOrEqual(b.left)
    expect(x).toBeLessThanOrEqual(b.left + b.width)
  })

  test('ticks are clock times, one opening each active stretch', () => {
    const tl = layoutTimeline([run('a', 0, 2 * MIN), run('b', 30 * MIN, 2 * MIN)], OPTS)
    expect(tl.ticks.length).toBeGreaterThanOrEqual(2)
    for (const t of tl.ticks) expect(t.label).toMatch(/^\d{1,2}:\d{2}(:\d{2})? (am|pm)$/)
    expect(tl.ticks[0]!.label).toBe('3:04 pm')
    expect(tl.ticks.some((t) => t.label === '3:34 pm')).toBe(true)
    const pxs = tl.ticks.map((t) => t.px)
    expect(pxs).toEqual(pxs.toSorted((x, y) => x - y))
  })

  test('long stretches get inner ticks on round clock times', () => {
    const tl = layoutTimeline([run('a', 0, 40 * MIN)], OPTS)
    expect(tl.ticks.length).toBeGreaterThan(2)
    for (const t of tl.ticks.slice(1)) expect(t.label).toMatch(/:\d[05] (am|pm)$/)
  })

  test('overlapping runs merge into one stretch without a break', () => {
    const tl = layoutTimeline([run('a', 0, 10 * MIN), run('b', 4 * MIN, 10 * MIN)], OPTS)
    expect(tl.breaks).toHaveLength(0)
  })

  test('no intervals yields an empty timeline at the track width', () => {
    const tl = layoutTimeline([], OPTS)
    expect(tl.widthPx).toBe(686)
    expect(tl.breaks).toEqual([])
    expect(tl.ticks).toEqual([])
  })
})

const at = (h: number, m: number, sec: number, ms: number) =>
  new Date(2026, 10, 17, h, m, sec, ms).getTime()

// The "Unlinked PRs" order as it really ran: a 61 s pause, a 25 min break, then a 1.5 s hand-off.
const UNLINKED: Interval[] = [
  { id: 'cookA', start: at(21, 4, 18, 656), end: at(21, 4, 18, 995) },
  { id: 'cookB', start: at(21, 5, 20, 259), end: at(21, 5, 25, 747) },
  { id: 'remake', start: at(21, 30, 26, 909), end: at(21, 33, 8, 872) },
  { id: 'taste', start: at(21, 33, 10, 367), end: at(21, 35, 7, 334) },
  { id: 'cookC', start: new Date(2026, 10, 18, 0, 1, 6, 686).getTime(), end: new Date(2026, 10, 18, 0, 1, 17, 723).getTime() },
]
const REAL = { minBlockPx: 160, gapMs: 5 * MIN, breakPx: 84 }

describe('layoutTimeline gap classes (Unlinked PRs order)', () => {
  test('a 61 s pause is a 12 px spacer at any track width', () => {
    for (const trackPx of [966, 1500]) {
      const tl = layoutTimeline(UNLINKED, { ...REAL, trackPx })
      const a = tl.blocks.cookA!
      const b = tl.blocks.cookB!
      expect(b.left - (a.left + a.width)).toBeCloseTo(12, 5)
      expect(tl.spacers).toHaveLength(1)
      expect(tl.spacers[0]!.width).toBe(12)
    }
  })

  test('a 1.5 s hand-off draws no gap: blocks touch', () => {
    for (const trackPx of [966, 1500]) {
      const tl = layoutTimeline(UNLINKED, { ...REAL, trackPx })
      const r = tl.blocks.remake!
      expect(tl.blocks.taste!.left - (r.left + r.width)).toBeLessThanOrEqual(2)
    }
  })

  test('a 25 min pause is a break, not a spacer', () => {
    const tl = layoutTimeline(UNLINKED, { ...REAL, trackPx: 966 })
    expect(tl.breaks[0]!.skippedMs).toBeCloseTo(25 * MIN + 1162, -3)
    expect(tl.spacers.every((s) => s.idleMs < 5 * MIN)).toBe(true)
  })

  test('every block keeps at least minBlockPx', () => {
    for (const trackPx of [966, 1500]) {
      const tl = layoutTimeline(UNLINKED, { ...REAL, trackPx })
      for (const id of ['cookA', 'cookB', 'remake', 'taste', 'cookC']) {
        expect(tl.blocks[id]!.width).toBeGreaterThanOrEqual(160)
      }
    }
  })

  test('the spacer reports the idle time it stands for', () => {
    const tl = layoutTimeline(UNLINKED, { ...REAL, trackPx: 966 })
    expect(tl.spacers[0]!.idleMs).toBeCloseTo(61 * SEC, -3)
  })

  test('content fills the track when run durations allow it', () => {
    const tl = layoutTimeline(UNLINKED, { ...REAL, trackPx: 1500 })
    expect(tl.widthPx).toBeCloseTo(1500, 5)
  })

  test('xAt crosses a spacer monotonically and keeps ticks apart', () => {
    const tl = layoutTimeline(UNLINKED, { ...REAL, trackPx: 966 })
    const s = tl.spacers[0]!
    const mid = tl.xAt(at(21, 4, 50, 0))
    expect(mid).toBeGreaterThan(s.left)
    expect(mid).toBeLessThan(s.left + s.width)
    for (let i = 1; i < tl.ticks.length; i++) {
      expect(tl.ticks[i]!.px - tl.ticks[i - 1]!.px).toBeGreaterThanOrEqual(120)
    }
  })
})

describe('clockLabel', () => {
  test('formats noon, midnight and afternoon as 12-hour clock times', () => {
    expect(clockLabel(new Date(2026, 0, 1, 0, 5).getTime())).toBe('12:05 am')
    expect(clockLabel(new Date(2026, 0, 1, 12, 0).getTime())).toBe('12:00 pm')
    expect(clockLabel(new Date(2026, 0, 1, 15, 4, 9).getTime(), true)).toBe('3:04:09 pm')
  })
})
