<template>
  <div class="code" :class="{ 'code--invalid': invalid, 'code--disabled': disabled, 'code--focus': focused }">
    <input
      ref="el"
      class="code__input"
      type="text"
      name="code"
      data-test="code"
      inputmode="numeric"
      autocomplete="one-time-code"
      pattern="[0-9]*"
      :maxlength="length"
      :aria-label="t('login.code')"
      :aria-invalid="invalid ? 'true' : null"
      :disabled="disabled"
      :value="modelValue"
      @input="onInput"
      @paste="onPaste"
      @focus="onFocus"
      @blur="focused = false"
      @click="toEnd"
    >
    <span class="code__cells" aria-hidden="true">
      <span
        v-for="i in length"
        :key="i"
        class="code__cell"
        :class="{ 'code__cell--active': focused && !disabled && i - 1 === Math.min(modelValue.length, length - 1) }"
      >{{ modelValue[i - 1] || '' }}</span>
    </span>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { t } from '../i18n.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  length: { type: Number, default: 6 },
  disabled: { type: Boolean, default: false },
  invalid: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'complete'])

const el = ref(null)
const focused = ref(false)
// Last value that fired `complete`; a repeat needs a different code.
let fired = ''

watch(() => props.modelValue, (v) => {
  if (v.length < props.length) fired = ''
  if (el.value && el.value.value !== v) el.value.value = v
})

function digits(s) {
  return String(s).replace(/\D/g, '').slice(0, props.length)
}

function apply(raw) {
  if (props.disabled) return
  const v = digits(raw)
  if (el.value) el.value.value = v
  if (v !== props.modelValue) emit('update:modelValue', v)
  if (v.length === props.length && v !== fired) {
    fired = v
    emit('complete', v)
  }
}

function onInput(e) { apply(e.target.value) }

function onPaste(e) {
  e.preventDefault()
  apply(e.clipboardData?.getData('text') || '')
}

function toEnd() {
  const n = el.value?.value.length ?? 0
  el.value?.setSelectionRange?.(n, n)
}

function onFocus() {
  focused.value = true
  toEnd()
}

defineExpose({ focus: () => el.value?.focus() })
</script>
