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
</script>

<template>
  <div class="sessions">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div v-if="ordered.length" class="list-head dim">{{ ordered.length }} orders</div>

    <div v-if="ordered.length" class="cards">
      <SessionCard
        v-for="s in ordered"
        :key="s.adw_id"
        :session="s"
        :now-ms="nowMs"
      />
    </div>
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
}





</style>
