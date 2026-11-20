<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import type { OrderSummary } from '../lib/types'
import {
  addProject,
  deleteProject,
  fetchFactory,
  fetchSessions,
  setMode,
  setProjectDependsOn,
  setProjectPaused,
  type FactoryState,
  type ModeInfo,
  type ProjectInfo,
  type TaskMode,
} from '../lib/api'
import { ts } from '../lib/format'
import SessionCard from './SessionCard.vue'
import ModeSwitch from './ModeSwitch.vue'

const sessions = shallowRef<OrderSummary[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())
const factory = ref<FactoryState | null>(null)

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

interface Group {
  /** The project: a repository the factory manages. */
  info: ProjectInfo
  /** Sessions with work left, in the engineer-first order. */
  sessions: OrderSummary[]
  /** Sessions whose every task is completed: shown collapsed, at the bottom of the project. */
  completed: OrderSummary[]
  latest: number
}

// One section per project (a repository), most recently active first. A project with no sessions yet still
// gets its section, so its mode and what it depends on can be set before the first order.
const groups = computed<Group[]>(() => {
  const byName = new Map<string, Group>()
  for (const info of factory.value?.projects ?? []) byName.set(info.name, { info, sessions: [], completed: [], latest: -Infinity })
  for (const s of ordered.value) {
    const name = s.project ?? ''
    let g = byName.get(name)
    if (!g) {
      // A session whose project the factory state does not list yet (it was just added).
      g = { info: { name, path: '', paused: false, dependsOn: [], waitingOn: [], tasks: 0 }, sessions: [], completed: [], latest: -Infinity }
      byName.set(name, g)
    }
    if (s.completed) g.completed.push(s)
    else g.sessions.push(s)
    const t = ts(s.started_at)
    if (Number.isFinite(t) && t > g.latest) g.latest = t
  }
  return [...byName.values()].toSorted((a, b) => b.latest - a.latest || a.info.name.localeCompare(b.info.name))
})

/** A project's mode: its own setting, or the factory default it inherits. */
function projectMode(name: string): ModeInfo | null {
  const settings = factory.value?.settings
  if (!settings) return null
  const own = settings.projects[name] ?? null
  return { mode: own ?? settings.defaultMode, from: own ? 'project' : 'default', own, inherited: settings.defaultMode }
}

const busy = ref<string | null>(null)
const errors = reactive<Record<string, string>>({})

/** Runs one change to a project, shows its error under that project's heading, and refreshes. */
async function act(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  busy.value = name
  delete errors[name]
  try {
    await fn()
    await tick()
    return true
  } catch (err) {
    errors[name] = err instanceof Error ? err.message : String(err)
    return false
  } finally {
    busy.value = null
  }
}

/** The projects `g` could start depending on: every other project it does not depend on yet. */
const candidates = (g: Group): string[] =>
  (factory.value?.projects ?? []).map((p) => p.name).filter((n) => n !== g.info.name && !g.info.dependsOn.includes(n))

function addDependsOn(g: Group, e: Event) {
  const el = e.target as HTMLSelectElement
  const name = el.value
  el.value = ''
  if (name) void act(g.info.name, () => setProjectDependsOn(g.info.name, [...g.info.dependsOn, name]))
}

// Removing a project deletes all its tasks, so it asks first.
const confirming = ref<string | null>(null)
async function confirmDelete(name: string) {
  if (await act(name, () => deleteProject(name))) confirming.value = null
}

// Adding a repository: by the folder it is checked out in.
const ADD = '+add'
const newPath = ref('')
async function commitAdd() {
  const path = newPath.value.trim()
  if (!path) return
  if (await act(ADD, () => addProject(path))) newPath.value = ''
}
</script>

<template>
  <div class="sessions">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div class="list-head dim">
      <span v-if="ordered.length">{{ ordered.length }} orders</span>
      <form class="add-repo" @submit.prevent="commitAdd">
        <input v-model="newPath" class="in" placeholder="add a repository: path of its folder" aria-label="Folder of the repository to add" :disabled="busy === ADD" />
        <button type="submit" :disabled="busy === ADD || !newPath.trim()">Add</button>
        <span v-if="errors[ADD]" class="err">{{ errors[ADD] }}</span>
      </form>
    </div>

    <template v-if="groups.length">
      <section v-for="g in groups" :key="g.info.name" class="group">
        <h2 class="group-head">
          <span class="group-name" :title="g.info.path || g.info.name">{{ g.info.name }}</span>
          <span class="group-count dim">{{ g.sessions.length + g.completed.length }}</span>
          <ModeSwitch
            v-if="projectMode(g.info.name)"
            class="group-ctl"
            :info="projectMode(g.info.name)!"
            :busy="busy === g.info.name"
            @set="(m: TaskMode | null) => act(g.info.name, () => setMode('projects', g.info.name, m))"
          />
          <button
            type="button"
            class="group-ctl btn"
            :class="{ paused: g.info.paused }"
            :disabled="busy === g.info.name"
            :title="g.info.paused ? 'This project starts nothing new. Running agents finish. Click to resume.' : 'Stop starting new work in this project. Running agents finish.'"
            @click="act(g.info.name, () => setProjectPaused(g.info.name, !g.info.paused))"
          >
            {{ g.info.paused ? 'paused · resume' : 'pause' }}
          </button>
          <button type="button" class="group-ctl btn danger" :disabled="busy === g.info.name" title="Remove this repository from the factory and delete all its tasks" @click="confirming = g.info.name">
            remove
          </button>
        </h2>

        <div class="group-deps">
          <span class="dim">depends on</span>
          <span v-if="!g.info.dependsOn.length" class="faint">nothing</span>
          <span v-for="d in g.info.dependsOn" :key="d" class="chip" :class="{ waiting: g.info.waitingOn.includes(d) }">
            {{ d }}
            <button
              type="button"
              class="chip-x"
              :disabled="busy === g.info.name"
              :title="`Stop waiting for ${d}`"
              :aria-label="`Remove dependency on ${d}`"
              @click="act(g.info.name, () => setProjectDependsOn(g.info.name, g.info.dependsOn.filter((x) => x !== d)))"
            >
              ×
            </button>
          </span>
          <select v-if="candidates(g).length" class="in dep-add" :disabled="busy === g.info.name" aria-label="Add a project to depend on" @change="addDependsOn(g, $event)">
            <option value="">+ add</option>
            <option v-for="n in candidates(g)" :key="n" :value="n">{{ n }}</option>
          </select>
          <span v-if="g.info.waitingOn.length" class="waiting-note">
            waiting on project {{ g.info.waitingOn.join(', ') }}: no new task starts here until it is finished
          </span>
        </div>

        <div v-if="confirming === g.info.name" class="confirm" role="alertdialog" aria-label="Confirm remove">
          <strong>Remove {{ g.info.name }} from the factory?</strong>
          <span class="dim">
            This deletes all {{ g.info.tasks }} of its tasks for good: their agents are stopped, their open PRs closed, their branches deleted and their history erased.
            The repository's code and its main branch are not touched.
          </span>
          <span class="btns">
            <button type="button" class="btn danger" :disabled="busy === g.info.name" @click="confirmDelete(g.info.name)">{{ busy === g.info.name ? 'removing…' : 'Remove' }}</button>
            <button type="button" class="btn" :disabled="busy === g.info.name" @click="confirming = null">Cancel</button>
          </span>
        </div>
        <p v-if="errors[g.info.name]" class="err group-err">{{ errors[g.info.name] }}</p>

        <div v-if="g.sessions.length" class="cards">
          <SessionCard v-for="s in g.sessions" :key="s.adw_id" :session="s" :now-ms="nowMs" @changed="tick" />
        </div>
        <p v-else-if="!g.completed.length" class="empty-project faint">no orders yet — run take_order in this repository</p>
        <details v-if="g.completed.length" class="completed-group">
          <summary class="dim">Completed ({{ g.completed.length }})</summary>
          <div class="cards">
            <SessionCard v-for="s in g.completed" :key="s.adw_id" :session="s" :now-ms="nowMs" @changed="tick" />
          </div>
        </details>
      </section>
    </template>
    <div v-else-if="loaded" class="empty-state">no projects yet — run take_order in a repository, or add one above</div>
    <div v-else-if="!apiError" class="empty-state">loading sessions…</div>
  </div>
</template>

<style scoped>
.list-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 24px;
}

.add-repo {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  font-size: 15px;
}

.in {
  min-width: 0;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-3);
  color: var(--text);
  font: inherit;
}

.add-repo .in {
  width: min(360px, 70vw);
}

button,
.btn {
  padding: 3px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  font-size: 15px;
  font-weight: 400;
  cursor: pointer;
}

button:hover:not(:disabled) {
  background: var(--panel-hover);
}

button:disabled {
  opacity: 0.6;
  cursor: default;
}

.btn.paused {
  border-color: var(--amber-line);
  color: var(--amber);
}

.danger {
  color: var(--red);
}

.danger:hover:not(:disabled) {
  border-color: var(--red-line);
}

.group-ctl {
  flex: none;
  font-weight: 400;
}

.group-deps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 8px 24px 0;
  font-size: 15px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 4px 1px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--text);
}

.chip.waiting {
  border-color: var(--amber-line);
  color: var(--amber);
}

.chip-x {
  padding: 0 6px;
  border-color: transparent;
  background: none;
  color: var(--faint);
}

.chip-x:hover:not(:disabled) {
  background: none;
  color: var(--red);
}

.dep-add {
  padding: 1px 6px;
}

.waiting-note {
  color: var(--amber);
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 12px 24px 0;
  padding: 14px 16px;
  border: 1px solid var(--red-line);
  border-radius: 10px;
  background: var(--panel-3);
  font-size: 15px;
}

.btns {
  display: flex;
  gap: 10px;
}

.err {
  color: var(--red);
}

.group-err {
  margin: 8px 24px 0;
}

.empty-project {
  margin: 0;
  padding: 16px 24px 24px;
  font-size: 16px;
}

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
