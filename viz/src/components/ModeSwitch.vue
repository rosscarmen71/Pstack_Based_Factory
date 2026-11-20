<script setup lang="ts">
import type { ModeInfo, TaskMode } from '../lib/api'

// One hands-on / hands-off switch, used at every level it can be set: the factory default, a project, a session
// and a task. `info` says what applies, what the level would inherit, and whether it overrides that.
const props = withDefaults(
  defineProps<{
    info: ModeInfo
    /** False for the factory default, which has nothing above it to inherit from. */
    resettable?: boolean
    busy?: boolean
    compact?: boolean
  }>(),
  { resettable: true, busy: false, compact: false },
)
const emit = defineEmits<{ (e: 'set', mode: TaskMode | null): void }>()

const MODES: { value: TaskMode; label: string; title: string }[] = [
  { value: 'hands-on', label: 'hands-on', title: 'A task that depends on this waits until it is merged' },
  { value: 'hands-off', label: 'hands-off', title: 'A task that depends on this may start once it has passed taste_test cleanly' },
]

function pick(mode: TaskMode) {
  if (props.busy) return
  // Picking what is already inherited, with no override in place, changes nothing.
  if (props.info.own === null && mode === props.info.mode) return
  if (props.info.own === mode) return
  emit('set', mode)
}
</script>

<template>
  <!-- Often sits inside a link or a clickable row: no event may reach it. -->
  <span class="mode" :class="{ compact }" @click.prevent.stop @mousedown.stop @keydown.stop>
    <span class="seg" role="radiogroup" aria-label="Mode">
      <button
        v-for="m in MODES"
        :key="m.value"
        type="button"
        class="seg-btn"
        :class="{ on: info.mode === m.value, [m.value]: true }"
        role="radio"
        :aria-checked="info.mode === m.value"
        :title="m.title"
        :disabled="busy"
        @click="pick(m.value)"
      >
        {{ m.label }}
      </button>
    </span>
    <template v-if="resettable">
      <button
        v-if="info.own !== null"
        type="button"
        class="reset"
        :title="`Set here. Without it this would be ${info.inherited}. Click to inherit again.`"
        :disabled="busy"
        @click="emit('set', null)"
      >
        {{ info.own === info.inherited ? 'set here' : `overrides ${info.inherited}` }} · reset
      </button>
      <span v-else class="from faint" :title="`Inherited from the ${info.from}`">from {{ info.from }}</span>
    </template>
  </span>
</template>

<style scoped>
.mode {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  white-space: nowrap;
  cursor: default;
}

.seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.seg-btn {
  padding: 3px 10px;
  border: 0;
  background: var(--panel-3);
  color: var(--faint);
  font: inherit;
  cursor: pointer;
}

.compact .seg-btn {
  padding: 2px 8px;
}

.seg-btn + .seg-btn {
  border-left: 1px solid var(--border);
}

.seg-btn:hover:not(:disabled):not(.on) {
  background: var(--panel-hover);
  color: var(--text);
}

.seg-btn.on {
  color: var(--bg);
  font-weight: 700;
  cursor: default;
}

.seg-btn.on.hands-on {
  background: var(--blue);
}

.seg-btn.on.hands-off {
  background: var(--amber);
}

.seg-btn:disabled {
  opacity: 0.6;
}

.reset {
  padding: 2px 8px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: none;
  color: var(--dim);
  font: inherit;
  cursor: pointer;
}

.reset:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--dim);
}
</style>
