<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { fetchFactory, updateFactory, type FactoryState, type ModeInfo, type TaskMode } from '../lib/api'
import ModeSwitch from './ModeSwitch.vue'

// The factory-wide switches in the top bar: the default mode, how many agents may run at once, and pause.
// Also says what the loop is doing: how many agents are running, and any usage-limit pause.
const state = ref<FactoryState | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)
let timer: ReturnType<typeof setInterval> | undefined

async function pull() {
  try {
    state.value = await fetchFactory()
  } catch {
    // The views show their own "api unreachable" bar; keep the last known switches.
  }
}

async function change(patch: Parameters<typeof updateFactory>[0]) {
  busy.value = true
  error.value = null
  try {
    await updateFactory(patch)
    await pull()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void pull()
  timer = setInterval(() => void pull(), 2000)
})
onUnmounted(() => clearInterval(timer))

const defaultInfo = computed<ModeInfo | null>(() => {
  const mode = state.value?.settings.defaultMode
  return mode ? { mode, from: 'default', own: mode, inherited: mode } : null
})
const caps = computed(() => Array.from({ length: state.value?.maxAgentCap ?? 0 }, (_, i) => i + 1))
const running = computed(() => state.value?.loop.running ?? [])
const runningTitle = computed(() =>
  running.value.length ? running.value.map((r) => `${r.kind} ${r.kind === 'dev-task' ? r.target : `#${r.target}`}`).join('\n') : 'No agent is running',
)
const limitUntil = computed(() => {
  const iso = state.value?.loop.pausedUntil
  if (!iso || Date.parse(iso) <= Date.now()) return null
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
})
</script>

<template>
  <span v-if="state && defaultInfo" class="factory">
    <span v-if="limitUntil" class="limit" title="Your Claude usage limit was reached. Nothing new starts until it resets; work resumes by itself.">
      paused: usage limit, resumes at {{ limitUntil }}
    </span>
    <span class="item" :title="runningTitle">
      <span class="count">{{ running.length }}</span> of
      <select
        class="cap"
        :value="state.settings.agentCap"
        :disabled="busy"
        aria-label="Agents allowed to run at once"
        title="How many agents may run at once"
        @change="change({ agentCap: Number(($event.target as HTMLSelectElement).value) })"
      >
        <option v-for="n in caps" :key="n" :value="n">{{ n }}</option>
      </select>
      agents
    </span>
    <span class="item">
      <span class="dim">default</span>
      <ModeSwitch :info="defaultInfo" :resettable="false" :busy="busy" @set="(m: TaskMode | null) => m && change({ defaultMode: m })" />
    </span>
    <button
      type="button"
      class="pause"
      :class="{ paused: state.settings.paused }"
      :disabled="busy"
      :title="state.settings.paused ? 'Starts are paused. Running agents finish. Click to resume.' : 'Stop starting new work. Running agents finish.'"
      @click="change({ paused: !state.settings.paused })"
    >
      {{ state.settings.paused ? 'paused · resume' : 'pause' }}
    </button>
    <span v-if="error" class="err" :title="error">{{ error }}</span>
  </span>
</template>

<style scoped>
.factory {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 18px;
  font-size: 15px;
  color: var(--dim);
}

.item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}

.count {
  color: var(--text);
  font-family: var(--mono);
}

.cap {
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel-3);
  color: var(--text);
  font: inherit;
}

.pause {
  padding: 3px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-3);
  color: var(--dim);
  font: inherit;
  cursor: pointer;
}

.pause:hover:not(:disabled) {
  color: var(--text);
  background: var(--panel-hover);
}

.pause.paused {
  border-color: var(--amber-line);
  color: var(--amber);
}

.limit {
  padding: 2px 10px;
  border: 1px solid var(--amber-line);
  border-radius: 8px;
  color: var(--amber);
  white-space: nowrap;
}

.err {
  color: var(--red);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
