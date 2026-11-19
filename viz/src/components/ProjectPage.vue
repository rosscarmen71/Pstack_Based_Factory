<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { OrderSummary } from '../lib/types'
import { fetchSessions } from '../lib/api'
import { ts } from '../lib/format'
import { hrefFor } from '../lib/router'
import SessionCard from './SessionCard.vue'

const props = defineProps<{ project: string }>()

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

// This project's sessions in the main page's engineer-first order: needs the
// engineer float up, broken ones first, then most recently started.
const ordered = computed(() =>
  sessions.value
    .filter((s) => (s.project?.trim() ? s.project : null) === props.project)
    .toSorted(
      (a, b) =>
        Number(b.needs_broken > 0) - Number(a.needs_broken > 0) ||
        Number(b.needs_open > 0) - Number(a.needs_open > 0) ||
        (ts(b.started_at) || 0) - (ts(a.started_at) || 0),
    ),
)

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

    <template v-if="ordered.length">
      <div class="list-head dim">{{ ordered.length }} orders</div>
      <div class="cards">
        <SessionCard
          v-for="s in ordered"
          :key="s.adw_id"
          :session="s"
          :now-ms="nowMs"
          :projects="projectNames"
          @project-changed="tick"
        />
      </div>
    </template>
    <div v-else-if="loaded" class="empty-state">
      No sessions in this project — <a :href="hrefFor()">back to all sessions</a>
    </div>
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

.cards {
  /* Uniform grid: every card the same width and (fixed in SessionCard) height,
     independent of content. Matches the main sessions page. */
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(460px, 100%), 1fr));
  gap: 18px;
  padding: 16px 24px 28px;
}

.empty-state a {
  color: var(--cyan);
}

@media (max-width: 640px) {
  .cards {
    padding: 12px 16px 24px;
  }
}
</style>
