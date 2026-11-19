import { ref } from 'vue'
import { parseHash, hrefFor, hrefForProject, type Route } from './routes'

export type { Route } from './routes'
export { hrefFor, hrefForProject } from './routes'

function parse(): Route {
  return parseHash(window.location.hash)
}

const route = ref<Route>(parse())

window.addEventListener('hashchange', () => {
  route.value = parse()
})

export function useRoute() {
  return route
}

// Display name for the phase crumb — set by the trace view once phases load,
// since the phase_id in the URL is not the display name.
export const phaseCrumb = ref<string | null>(null)

export function navigate(adwId?: string | null, phaseId?: string | null): void {
  window.location.hash = hrefFor(adwId, phaseId)
}

export function navigateProject(name: string): void {
  window.location.hash = hrefForProject(name)
}
