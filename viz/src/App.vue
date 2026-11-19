<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, hrefFor, phaseCrumb } from './lib/router'
import { fetchHealth } from './lib/api'
import type { HealthResponse } from './lib/types'
import SessionsList from './components/SessionsList.vue'
import SessionTrace from './components/SessionTrace.vue'

const route = useRoute()

const health = ref<HealthResponse | null>(null)
let healthTimer: ReturnType<typeof setInterval> | undefined

async function pollHealth() {
  try {
    health.value = await fetchHealth()
  } catch {
    // Unreachable API: the views show their own error bar; the loop state is unknown.
    health.value = null
  }
}

onMounted(() => {
  void pollHealth()
  healthTimer = setInterval(() => void pollHealth(), 2000)
})

onUnmounted(() => clearInterval(healthTimer))

const loopRunning = computed(() => health.value?.loop_running === true)
const healthErrors = computed(() => Object.entries(health.value?.errors ?? {}))
</script>

<template>
  <div class="app">
    <header class="topbar">
      <nav class="crumbs">
        <!-- Inline copy of public/logo.svg (the favicon) so the mark renders
             crisply with no fetch; keep the two in sync. -->
        <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
          <rect x="4" y="6" width="17" height="5" rx="2.5" style="fill: var(--amber)" />
          <rect x="8" y="13.5" width="20" height="5" rx="2.5" style="fill: var(--purple)" />
          <rect x="4" y="21" width="13" height="5" rx="2.5" style="fill: var(--cyan)" />
        </svg>
        <span class="brand">Pstack Based Software Factory</span>
        <span class="sep">›</span>
        <a :href="hrefFor()" :class="{ current: !route.adwId }">sessions</a>
        <template v-if="route.adwId">
          <span class="sep">›</span>
          <a :href="hrefFor(route.adwId)" :class="{ current: !route.phaseId }">{{
            route.adwId
          }}</a>
        </template>
        <template v-if="route.adwId && route.phaseId">
          <span class="sep">›</span>
          <span class="current">{{ phaseCrumb ?? route.phaseId }}</span>
        </template>
      </nav>
      <span class="status-hints">
        <span class="live-hint" :title="loopRunning ? 'factory/loop.ts is running' : 'No loop process is running'">
          <span class="loop-dot" :class="{ on: loopRunning }" />
          loop: {{ loopRunning ? 'running' : 'not running' }}
        </span>
        <span class="live-hint"><span class="live-dot" /> live</span>
      </span>
    </header>
    <div v-if="healthErrors.length" class="error-bar health-errors">
      <div v-for="[source, message] in healthErrors" :key="source">
        <strong>{{ source }}</strong> — {{ message }}
      </div>
    </div>
    <main>
      <SessionsList v-if="!route.adwId" />
      <SessionTrace v-else :key="route.adwId" :adw-id="route.adwId" :phase-id="route.phaseId" />
    </main>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 20px;
  padding: 15px 28px;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 10;
}

@media (max-width: 640px) {
  .topbar {
    padding: 12px 16px;
  }
}

.crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 17px;
  min-width: 0;
}

.logo {
  width: 28px;
  height: 28px;
  flex: none;
}

.brand {
  color: var(--text);
  font-weight: 700;
  letter-spacing: 0.05em;
  white-space: nowrap;
}

.sep {
  color: var(--faint);
}

.crumbs a {
  color: var(--dim);
}

.crumbs a:hover {
  color: var(--text);
}

.crumbs .current {
  color: var(--text);
}

.status-hints {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 22px;
  margin-left: auto;
}

.health-errors {
  margin: 0;
  border-radius: 0;
  border-width: 0 0 1px;
  padding: 6px 28px;
}

.loop-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--faint);
}

.loop-dot.on {
  background: var(--green);
  animation: pulse 1.6s ease-in-out infinite;
}

.live-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--dim);
  font-size: 16px;
  white-space: nowrap;
}

.live-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--green);
  animation: pulse 1.6s ease-in-out infinite;
}
</style>
