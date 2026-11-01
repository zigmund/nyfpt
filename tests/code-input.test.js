// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import CodeInput from '../src/components/CodeInput.vue'

// Host with v-model, like LoginScreen uses it.
function host(extra = {}) {
  const completes = []
  const value = ref('')
  const Host = defineComponent({
    setup: () => () => h(CodeInput, {
      modelValue: value.value,
      'onUpdate:modelValue': (v) => { value.value = v },
      onComplete: () => completes.push(value.value),
      length: 6,
      ...extra,
    }),
  })
  const wrapper = mount(Host)
  return { wrapper, value, completes, input: wrapper.get('input') }
}

describe('CodeInput', () => {
  it('is one real numeric one-time-code input with 6 visual cells', () => {
    const { wrapper, input } = host()
    expect(wrapper.findAll('input')).toHaveLength(1)
    expect(input.attributes('inputmode')).toBe('numeric')
    expect(input.attributes('autocomplete')).toBe('one-time-code')
    // No maxlength: it would cut an autofilled "123 456" to 5 digits; digits() clamps instead.
    expect(input.attributes('maxlength')).toBeUndefined()
    expect(input.attributes('pattern')).toBe('[0-9]*')
    expect(input.attributes('aria-label')).toBe('Verification code')
    expect(wrapper.findAll('.code__cell')).toHaveLength(6)
  })

  it('autofill with a space ("123 456") becomes 6 digits and auto-submits', async () => {
    const { value, completes, input } = host()
    await input.setValue('123 456')
    expect(value.value).toBe('123456')
    expect(input.element.value).toBe('123456')
    expect(completes).toEqual(['123456'])
  })

  it('passes aria-describedby to the real input', () => {
    const { input } = host({ describedBy: 'hint-id' })
    expect(input.attributes('aria-describedby')).toBe('hint-id')
    expect(host().input.attributes('aria-describedby')).toBeUndefined()
  })

  it('emits complete exactly once on the 6th digit and fills cells', async () => {
    const { wrapper, value, completes, input } = host()
    for (const v of ['1', '12', '123', '1234', '12345']) await input.setValue(v)
    expect(completes).toHaveLength(0)
    await input.setValue('123456')
    expect(value.value).toBe('123456')
    expect(completes).toEqual(['123456'])
    expect(wrapper.findAll('.code__cell').map((c) => c.text()).join('')).toBe('123456')
    await input.setValue('123456') // same value again: no repeat
    expect(completes).toHaveLength(1)
  })

  it('drops non-digits', async () => {
    const { value, completes, input } = host()
    await input.setValue('1a2-b3')
    expect(value.value).toBe('123')
    expect(input.element.value).toBe('123')
    expect(completes).toHaveLength(0)
  })

  it('normalizes a pasted "123 456" and submits once', async () => {
    const { value, completes, input } = host()
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    ev.clipboardData = { getData: () => '123 456' }
    input.element.dispatchEvent(ev)
    await input.element.dispatchEvent(new Event('input'))
    expect(ev.defaultPrevented).toBe(true)
    expect(value.value).toBe('123456')
    expect(completes).toEqual(['123456'])
  })

  it('backspace removes the last digit and re-completing fires again', async () => {
    const { value, completes, input } = host()
    await input.setValue('123456')
    await input.setValue('12345')
    expect(value.value).toBe('12345')
    await input.setValue('123459')
    expect(completes).toEqual(['123456', '123459'])
  })

  it('re-arms after the parent clears the code (broker error)', async () => {
    const { wrapper, value, completes, input } = host()
    await input.setValue('123456')
    value.value = ''
    await wrapper.vm.$nextTick()
    expect(input.element.value).toBe('')
    await input.setValue('654321')
    expect(completes).toEqual(['123456', '654321'])
  })

  it('disabled blocks input', async () => {
    const { value, completes, input } = host({ disabled: true })
    expect(input.attributes('disabled')).toBeDefined()
    await input.setValue('123456')
    expect(value.value).toBe('')
    expect(completes).toHaveLength(0)
  })

  it('marks cells invalid', () => {
    const { wrapper } = host({ invalid: true })
    expect(wrapper.get('.code').classes()).toContain('code--invalid')
  })
})
