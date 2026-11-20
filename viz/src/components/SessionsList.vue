<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { OrderSummary } from '../lib/types'
import { fetchFactory, fetchSessions, setMode, type FactoryState, type ModeInfo, type TaskMode } from '../lib/api'
import { ts } from '../lib/format'
import SessionCard from './SessionCard.vue'
import ModeSwitch from './ModeSwitch.vue'

const sessions = shallowRef<OrderSummary[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())
const factory = ref<FactoryState | null>(null)

/** A project's mode: its own setting, or the factory default it inherits. */
function projectMode(name: string): ModeInfo | null {
  const settings = factory.value?.settings
  if (!settings) return null
  const own = settings.projects[name] ?? null
  return { mode: own ?? settings.defaultMode, from: own ? 'project' : 'default', own, inherited: settings.defaultMode }
}

const modeBusy = ref(false)
async function changeProjectMode(name: string, mode: TaskMode | null) {
  modeBusy.value = true
  try {
    await setMode('projects', name, mode)
    await tick()
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
  } finally {
    modeBusy.value = false
  }
}

let timer: ReturnType<typeof setInterval> | undefined
let inflight = false

async function tick() {
  if (inflight) return
  inflight = true
  try {
    const [list, factoryState] = await Promise.all([fetchSessions(), fetchFactory().catch(() => factory.value)])
    sessions.value = list
    factory.value = factoryState
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

onUnmounted(() => clearInterval(timer))

// Orders that need the engineer float to the top, broken ones first.
const ordered = computed(() =>
  sessions.value.toSorted(
    (a, b) =>
      Number(b.needs_broken > 0) - Number(a.needs_broken > 0) ||
      Number(b.needs_open > 0) - Number(a.needs_open > 0) ||
      (ts(b.started_at) || 0) - (ts(a.started_at) || 0),
  ),
)

const NO_PROJECT_LABEL = 'No project'

interface Group {
  name: string | null
  /** Sessions with work left, in the engineer-first order. */
  sessions: OrderSummary[]
  /** Sessions whose every task is completed: shown collapsed, at the bottom of the project. */
  completed: OrderSummary[]
  latest: number
}

// Sections by project, most recently started project first, "No project" last.
// Order within a section is the engineer-first order above.
const groups = computed<Group[]>(() => {
  const byName = new Map<string | null, Group>()
  for (const s of ordered.value) {
    const name = s.project?.trim() ? s.project : null
    let g = byName.get(name)
    if (!g) {
      g = { name, sessions: [], completed: [], latest: -Infinity }
      byName.set(name, g)
    }
    if (s.completed) g.completed.push(s)
    else g.sessions.push(s)
    const t = ts(s.started_at)
    if (Number.isFinite(t) && t > g.latest) g.latest = t
  }
  return [...byName.values()].toSorted(
    (a, b) =>
      Number(a.name === null) - Number(b.name === null) ||
      b.latest - a.latest ||
      (a.name ?? '').localeCompare(b.name ?? ''),
  )
})

// Every project name in use, for the move-to-project select on each card.
const projectNames = computed(() =>
  [...new Set(sessions.value.map((s) => s.project?.trim()).filter((p): p is string => !!p))].toSorted(
    (a, b) => a.localeCompare(b),
  ),
)
</script>

<template>
  <div class="sessions">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div v-if="ordered.length" class="list-head dim">{{ ordered.length }} orders</div>

    <template v-if="ordered.length">
    <section v-for="g in groups" :key="g.name ?? '\0none'" class="group">
      <h2 class="group-head">
        <span class="group-name" :class="{ none: g.name === null }" :title="g.name ?? NO_PROJECT_LABEL">{{
          g.name ?? NO_PROJECT_LABEL
        }}</span>
        <span class="group-count dim">{{ g.sessions.length + g.completed.length }}</span>
        <ModeSwitch
          v-if="g.name !== null && projectMode(g.name)"
          class="group-mode"
          :info="projectMode(g.name)!"
          :busy="modeBusy"
          @set="(m: TaskMode | null) => changeProjectMode(g.name!, m)"
        />
      </h2>
      <div class="cards">
        <SessionCard
          v-for="s in g.sessions"
          :key="s.adw_id"
          :session="s"
          :now-ms="nowMs"
          :projects="projectNames"
          @project-changed="tick"
        />
      </div>
      <details v-if="g.completed.length" class="completed-group">
        <summary class="dim">Completed ({{ g.completed.length }})</summary>
        <div class="cards">
          <SessionCard
            v-for="s in g.completed"
            :key="s.adw_id"
            :session="s"
            :now-ms="nowMs"
            :projects="projectNames"
            @project-changed="tick"
          />
        </div>
      </details>
    </section>
    </template>
    <div v-else-if="loaded" class="empty-state">no orders yet — run take_order to see one here</div>
    <div v-else-if="!apiError" class="empty-state">loading sessions…</div>
  </div>
</template>

<style scoped>
.sessions {
  display: flex;
  flex-direction: column;
}

.list-head {
  padding: 16px 24px 0;
  font-size: 16px;
}

.group-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin: 0;
  padding: 24px 24px 0;
  font-size: 20px;
  font-weight: 700;
}

.group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.group-name.none {
  color: var(--dim);
}

.group-mode {
  flex: none;
  font-weight: 400;
}

.completed-group {
  padding: 0 24px 12px;
}

.completed-group > summary {
  cursor: pointer;
  font-size: 16px;
  padding: 4px 0 8px;
}

.completed-group .cards {
  padding: 8px 0 16px;
}

.group-count {
  flex: none;
  font-size: 16px;
  font-weight: 400;
}

.cards {
  /* Uniform grid: every card the same width and (fixed in SessionCard) height,
     independent of content. */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(460px, 100%), 1fr));
  gap: 18px;
  padding: 16px 24px 28px;
}

@media (max-width: 640px) {
  .cards {
    padding: 12px 16px 24px;
  }

  .group-head {
    padding: 16px 16px 0;
  }
}





</style>
