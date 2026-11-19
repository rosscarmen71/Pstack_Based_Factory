<script setup lang="ts">
import { computed } from 'vue'
import { Ban, Check, Circle, Hourglass, LoaderCircle, X } from 'lucide-vue-next'

const props = defineProps<{ status: string }>()

// Order-level words (broken / done) share the phase styles for fail / success.
const CLASS_OF: Record<string, string> = { broken: 'fail', done: 'success' }
const cls = computed(() => CLASS_OF[props.status] ?? props.status)

const ICONS: Record<string, unknown> = {
  success: Check,
  fail: X,
  running: LoaderCircle,
  queued: Circle,
  waiting: Hourglass,
  skipped: Ban,
}
</script>

<template>
  <span class="chip" :class="cls">
    <component :is="ICONS[cls] ?? Circle" class="chip-icon" :size="18" :stroke-width="2.5" />
    {{ status }}
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 3px 13px 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 16px;
  color: var(--dim);
  white-space: nowrap;
}

.chip-icon {
  flex: none;
}

.chip.success {
  color: var(--green);
  border-color: var(--green-line);
  background: color-mix(in srgb, var(--green) 10%, transparent);
}

.chip.fail {
  color: var(--red);
  border-color: var(--red-line);
  background: color-mix(in srgb, var(--red) 10%, transparent);
}

.chip.running {
  color: var(--blue);
  border-color: var(--blue-line);
  background: color-mix(in srgb, var(--blue) 10%, transparent);
}

.chip.running .chip-icon {
  animation: spin 1.1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.chip.queued,
.chip.waiting {
  color: var(--dim);
  border-style: dashed;
}

.chip.skipped {
  color: var(--amber);
  border-color: var(--amber-line);
  background: color-mix(in srgb, var(--amber) 10%, transparent);
}
</style>
