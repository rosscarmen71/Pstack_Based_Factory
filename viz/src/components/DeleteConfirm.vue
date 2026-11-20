<script setup lang="ts">
import { computed } from 'vue'
import type { DeletePreview } from '../lib/api'

// The question asked before a delete: what will be stopped, closed and erased, for one task or a whole session.
const props = defineProps<{
  /** Null while the preview is still loading. */
  previews: DeletePreview[] | null
  busy: boolean
  error: string | null
}>()
const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

const ids = computed(() => new Set((props.previews ?? []).map((p) => p.id)))
const prs = computed(() => (props.previews ?? []).flatMap((p) => (p.openPr === null ? [] : [p.openPr])))
const running = computed(() => (props.previews ?? []).filter((p) => p.status === 'in_progress').map((p) => p.id))
// Dependents that are being deleted too need no mention.
const released = computed(() => [...new Set((props.previews ?? []).flatMap((p) => p.dependents))].filter((d) => !ids.value.has(d)))
const what = computed(() => {
  const n = props.previews?.length ?? 0
  return n === 1 ? `task ${props.previews?.[0]?.id}` : `${n} tasks`
})
</script>

<template>
  <div class="confirm" role="alertdialog" aria-label="Confirm delete" @click.prevent.stop @mousedown.stop @keydown.stop>
    <template v-if="previews">
      <strong class="q">Delete {{ what }} for good?</strong>
      <ul class="effects">
        <li v-if="running.length">stops the agent running on {{ running.join(', ') }}</li>
        <li v-if="prs.length">closes {{ prs.map((n) => `PR #${n}`).join(', ') }} and deletes its branch</li>
        <li v-if="released.length">{{ released.join(', ') }} will no longer wait for it</li>
        <li>erases its history: runs, transcripts and attempt counts</li>
      </ul>
    </template>
    <span v-else class="dim">checking what this deletes…</span>
    <span v-if="error" class="err">{{ error }}</span>
    <span class="btns">
      <button type="button" class="danger" :disabled="busy || !previews" @click="emit('confirm')">
        {{ busy ? 'deleting…' : 'Delete' }}
      </button>
      <button type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
    </span>
  </div>
</template>

<style scoped>
.confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border: 1px solid var(--red-line);
  border-radius: 10px;
  background: var(--panel-3);
  color: var(--text);
  font-size: 15px;
  cursor: default;
}

.effects {
  margin: 0;
  padding-left: 18px;
  color: var(--dim);
}

.btns {
  display: flex;
  gap: 10px;
}

button {
  padding: 4px 14px;
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
  border-color: var(--red-line);
  color: var(--red);
}

.err {
  color: var(--red);
}
</style>
