<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { OrderSummary } from '../lib/types'
import { fetchSessions } from '../lib/api'
import { ts } from '../lib/format'
import SessionCard from './SessionCard.vue'

const sessions = shallowRef<OrderSummary[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())

let timer: ReturnType<typeof setInterval> | undefined
let inflight = false

async function tick() {
  if (inflight) return
  inflight = true
  try {
    sessions.value = await fetchSessions()
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
  sessions: OrderSummary[]
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
      g = { name, sessions: [], latest: -Infinity }
      byName.set(name, g)
    }
    g.sessions.push(s)
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
        <span class="group-count dim">{{ g.sessions.length }}</span>
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
