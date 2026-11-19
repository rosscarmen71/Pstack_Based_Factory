// Pure hash-route parsing and link building, with no window access, so it is
// unit-testable. router.ts wires these to window and Vue reactivity.

// Hash routes:
//   #/                       → sessions
//   #/projects/<name>        → one project's sessions
//   #/<adw_id>               → waterfall
//   #/<adw_id>/<phase_id>    → phase panel open
export interface Route {
  project: string | null
  adwId: string | null
  phaseId: string | null
}

export function parseHash(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent)
  if (parts[0] === 'projects') {
    return { project: parts[1] ?? null, adwId: null, phaseId: null }
  }
  return { project: null, adwId: parts[0] ?? null, phaseId: parts[1] ?? null }
}

export function hrefFor(adwId?: string | null, phaseId?: string | null): string {
  let h = '#/'
  if (adwId) h += encodeURIComponent(adwId)
  if (adwId && phaseId) h += `/${encodeURIComponent(phaseId)}`
  return h
}

export function hrefForProject(name: string): string {
  return `#/projects/${encodeURIComponent(name)}`
}
