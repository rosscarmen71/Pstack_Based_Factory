// WCAG contrast check for the palette in src/style.css :root. Exits non-zero on any miss.
// Run: bun scripts/contrast.ts (from viz/)

const css = await Bun.file(new URL('../src/style.css', import.meta.url)).text()
const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
const tokens = new Map<string, string>()
for (const m of root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) tokens.set(m[1]!, m[2]!)

const BACKGROUNDS = ['bg', 'panel', 'panel-2', 'panel-3', 'panel-hover']
const TEXT_AA = 4.5
const GRAPHIC_AA = 3

// Text tokens are checked on every surface they can land on; status outlines and dots on the
// surfaces a block or dot sits on.
const checks: { token: string; onTokens: string[]; min: number; kind: string }[] = [
  ...['text', 'dim', 'faint'].map((token) => ({ token, onTokens: BACKGROUNDS, min: TEXT_AA, kind: 'text' })),
  ...['green', 'red', 'amber', 'blue', 'purple', 'cyan', 'violet', 'pink'].map((token) => ({
    token,
    onTokens: ['bg', 'panel', 'panel-2', 'panel-hover'],
    min: TEXT_AA,
    kind: 'text',
  })),
  ...['green-line', 'red-line', 'amber-line', 'blue-line', 'faint'].map((token) => ({
    token,
    onTokens: ['panel', 'panel-2', 'panel-hover'],
    min: GRAPHIC_AA,
    kind: 'outline',
  })),
]

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

let failures = 0
const rows: string[] = []
for (const { token, onTokens, min, kind } of checks) {
  const fg = tokens.get(token)
  if (!fg) {
    rows.push(`${token.padEnd(12)} missing from :root`)
    failures++
    continue
  }
  for (const bgToken of onTokens) {
    const bg = tokens.get(bgToken)
    if (!bg) {
      rows.push(`${bgToken.padEnd(12)} missing from :root`)
      failures++
      continue
    }
    const ratio = contrast(fg, bg)
    const ok = ratio >= min
    if (!ok) failures++
    rows.push(
      `${ok ? 'ok  ' : 'FAIL'} ${kind.padEnd(7)} ${token.padEnd(11)} ${fg} on ${bgToken.padEnd(11)} ${bg}  ${ratio.toFixed(2)}:1 (need ${min}:1)`,
    )
  }
}

console.log(rows.join('\n'))
console.log(failures ? `\n${failures} pair(s) below target` : '\nall pairs meet target')
process.exit(failures ? 1 : 0)
