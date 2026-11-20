<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { LaneMeta, TaskInfo } from '../lib/types'
import {
  addDependency,
  completeTask,
  deleteTask,
  previewTaskDelete,
  removeDependency,
  retryTask,
  setMode,
  type DeletePreview,
  type TaskMode,
} from '../lib/api'
import ModeSwitch from './ModeSwitch.vue'
import DeleteConfirm from './DeleteConfirm.vue'

// One row per task of the session: its state, its mode, what it waits for and why, and the things the engineer
// can do to it (retry, mark completed, delete, add or remove a dependency).
const props = defineProps<{ laneMeta: Record<string, LaneMeta> }>()
const emit = defineEmits<{ (e: 'changed'): void }>()

const tasks = computed<TaskInfo[]>(() => Object.values(props.laneMeta).flatMap((m) => (m.task ? [m.task] : [])))
const ids = computed(() => tasks.value.map((t) => t.id))

const busy = ref<string | null>(null)
const errors = reactive<Record<string, string>>({})

/** Runs one action on a task, shows its error on that task's row, and refreshes the page's data after. */
async function act(id: string, fn: () => Promise<unknown>): Promise<boolean> {
  busy.value = id
  delete errors[id]
  try {
    await fn()
    emit('changed')
    return true
  } catch (err) {
    errors[id] = err instanceof Error ? err.message : String(err)
    return false
  } finally {
    busy.value = null
  }
}

const STATUS_TEXT: Record<TaskInfo['status'], string> = {
  pending: 'not started',
  in_progress: 'running',
  pr: 'PR open',
  completed: 'completed',
}
function statusText(t: TaskInfo): string {
  if (t.needsYou && t.status === 'pending') return 'parked'
  return STATUS_TEXT[t.status]
}

// Delete, with its confirmation.
const confirming = ref<string | null>(null)
const previews = ref<DeletePreview[] | null>(null)
async function askDelete(id: string) {
  confirming.value = id
  previews.value = null
  delete errors[id]
  try {
    previews.value = [await previewTaskDelete(id)]
  } catch (err) {
    errors[id] = err instanceof Error ? err.message : String(err)
  }
}
async function confirmDelete(id: string) {
  if (await act(id, () => deleteTask(id))) confirming.value = null
}

// Add a dependency by hand.
const adding = ref<string | null>(null)
const newDep = ref('')
const newReason = ref('')
function startAdd(id: string) {
  adding.value = id
  newDep.value = ''
  newReason.value = ''
}
async function commitAdd(id: string) {
  const dep = newDep.value.trim()
  const reason = newReason.value.trim()
  if (!dep || !reason) {
    errors[id] = 'Give the task to wait for and a one-line reason.'
    return
  }
  if (await act(id, () => addDependency(id, dep, reason))) adding.value = null
}
</script>

<template>
  <section v-if="tasks.length" class="tasks" aria-label="Tasks">
    <div v-for="t in tasks" :key="t.id" class="task" :class="{ completed: t.status === 'completed', parked: statusText(t) === 'parked' }">
      <div class="head">
        <code class="id">{{ t.id }}</code>
        <span class="status" :class="t.status">{{ statusText(t) }}</span>
        <ModeSwitch :info="t.mode" :busy="busy === t.id" compact @set="(m: TaskMode | null) => act(t.id, () => setMode('tasks', t.id, m))" />
        <span class="actions">
          <button
            v-if="t.needsYou && t.status === 'pending'"
            type="button"
            :disabled="busy === t.id"
            title="Clear the parked note and the failed-attempt count so the loop may start it again"
            @click="act(t.id, () => retryTask(t.id))"
          >
            Retry
          </button>
          <button
            v-if="t.status !== 'completed'"
            type="button"
            :disabled="busy === t.id"
            title="Mark it completed by hand: it is kept for history, never run again, and tasks waiting on it are released"
            @click="act(t.id, () => completeTask(t.id))"
          >
            Mark completed
          </button>
          <button type="button" class="danger" :disabled="busy === t.id" title="Delete this task for good" @click="askDelete(t.id)">Delete</button>
        </span>
      </div>

      <p v-if="t.needsYou" class="needs">needs you: {{ t.needsYou }}<span v-if="t.attempts"> · {{ t.attempts }} failed attempt{{ t.attempts === 1 ? '' : 's' }}</span></p>

      <ul v-if="t.dependencies.length" class="deps">
        <li v-for="d in t.dependencies" :key="d.id" :class="{ met: d.met }">
          <code>{{ d.id }}</code>
          <span class="dep-state">{{ d.met ? 'done' : d.text }}</span>
          <span v-if="d.reason" class="dep-reason dim">because: {{ d.reason }}</span>
          <button
            v-if="t.status !== 'completed'"
            type="button"
            class="x"
            :disabled="busy === t.id"
            :title="`Stop waiting for ${d.id}`"
            :aria-label="`Remove dependency ${d.id}`"
            @click="act(t.id, () => removeDependency(t.id, d.id))"
          >
            ×
          </button>
        </li>
      </ul>
      <p v-else-if="t.status !== 'completed'" class="dim nodeps">no dependencies</p>

      <div v-if="t.status !== 'completed'" class="add">
        <template v-if="adding === t.id">
          <input v-model="newDep" class="in" list="task-ids" placeholder="task to wait for" aria-label="Task to wait for" @keydown.enter.prevent="commitAdd(t.id)" @keydown.esc.prevent="adding = null" />
          <input v-model="newReason" class="in wide" placeholder="why (one line)" aria-label="Reason" @keydown.enter.prevent="commitAdd(t.id)" @keydown.esc.prevent="adding = null" />
          <button type="button" :disabled="busy === t.id" @click="commitAdd(t.id)">Add</button>
          <button type="button" @click="adding = null">Cancel</button>
        </template>
        <button v-else type="button" class="link" @click="startAdd(t.id)">+ add a dependency</button>
      </div>

      <DeleteConfirm
        v-if="confirming === t.id"
        :previews="previews"
        :busy="busy === t.id"
        :error="errors[t.id] ?? null"
        @confirm="confirmDelete(t.id)"
        @cancel="confirming = null"
      />
      <p v-else-if="errors[t.id]" class="err">{{ errors[t.id] }}</p>
    </div>
    <datalist id="task-ids">
      <option v-for="id in ids" :key="id" :value="id" />
    </datalist>
  </section>
</template>

<style scoped>
.tasks {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(520px, 100%), 1fr));
  gap: 12px;
  padding: 14px 24px 4px;
}

.task {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  font-size: 15px;
}

.task.parked {
  border-color: var(--red-line);
}

/* Completed: kept for history, stepped back. */
.task.completed {
  opacity: 0.55;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.id {
  font-family: var(--mono);
  color: var(--text);
  font-size: 15px;
}

.status {
  padding: 1px 9px;
  border: 1px solid var(--border);
  border-radius: 9px;
  color: var(--dim);
  white-space: nowrap;
}

.status.in_progress {
  color: var(--blue);
  border-color: var(--blue-line);
}

.status.pr {
  color: var(--purple);
}

.status.completed {
  color: var(--green);
  border-color: var(--green-line);
}

.parked .status {
  color: var(--red);
  border-color: var(--red-line);
}

.actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}

button {
  padding: 3px 11px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

button:hover:not(:disabled) {
  background: var(--panel-hover);
}

button:disabled {
  opacity: 0.6;
  cursor: default;
}

.danger {
  color: var(--red);
}

.danger:hover:not(:disabled) {
  border-color: var(--red-line);
}

.needs {
  margin: 0;
  color: var(--red);
}

.deps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.deps li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}

.deps code {
  font-family: var(--mono);
}

.dep-state {
  color: var(--amber);
}

.met .dep-state {
  color: var(--green);
}

.dep-reason {
  min-width: 0;
}

.x {
  padding: 0 7px;
  border-color: transparent;
  background: none;
  color: var(--faint);
}

.x:hover:not(:disabled) {
  color: var(--red);
  border-color: var(--red-line);
  background: none;
}

.nodeps {
  margin: 0;
}

.add {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.in {
  min-width: 0;
  flex: 1 1 140px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel-3);
  color: var(--text);
  font: inherit;
}

.in.wide {
  flex: 2 1 220px;
}

.link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--dim);
}

.link:hover:not(:disabled) {
  background: none;
  color: var(--text);
}

.err {
  margin: 0;
  color: var(--red);
}
</style>
