<template>
  <section
    class="login"
    :class="{ 'login--overlay': overlay }"
    :role="overlay ? 'dialog' : null"
    :aria-modal="overlay ? 'true' : null"
    aria-labelledby="login-title"
  >
    <div class="login__panel">
      <header class="login__head">
        <p class="login__app">{{ t('app.name') }}</p>
        <h1 id="login-title" class="login__title">{{ t('login.title') }}</h1>
      </header>

      <p v-if="expired" class="login__note">{{ t('login.expired') }}</p>
      <p v-if="mock" class="login__note login__note--mock">{{ t('login.mock') }}</p>

      <form class="login__form" @submit.prevent="submit">
        <label class="field">
          <span class="field__label">{{ t('login.cabinet') }}</span>
          <select v-model="cabinetId" class="input input--select" :disabled="busy" @change="resetCode">
            <option v-for="c in cabinets" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select>
        </label>

        <div class="seg" role="tablist" :aria-label="t('login.method')">
          <button
            v-for="m in MODES"
            :id="`login-tab-${m}`"
            :key="m"
            type="button"
            role="tab"
            class="seg__btn"
            :data-test="`tab-${m}`"
            :aria-selected="mode === m ? 'true' : 'false'"
            :aria-controls="`login-panel-${m}`"
            :tabindex="mode === m ? 0 : -1"
            @click="setMode(m)"
            @keydown.left.right.prevent="setMode(m === 'email' ? 'phone' : 'email', true)"
          >{{ t(m === 'email' ? 'login.tabEmail' : 'login.tabPhone') }}</button>
        </div>

        <div
          v-if="mode === 'email'"
          id="login-panel-email"
          class="login__fields"
          role="tabpanel"
          aria-labelledby="login-tab-email"
        >
          <label class="field">
            <span class="field__label">{{ t('login.login') }}</span>
            <input
              v-model.trim="loginName"
              class="input"
              type="text"
              name="username"
              autocomplete="username"
              autocapitalize="off"
              spellcheck="false"
              required
              :disabled="busy"
            >
          </label>
          <label class="field">
            <span class="field__label">{{ t('login.password') }}</span>
            <input
              v-model="password"
              class="input"
              type="password"
              name="password"
              autocomplete="current-password"
              required
              :disabled="busy"
            >
          </label>
        </div>

        <div
          v-else
          id="login-panel-phone"
          class="login__fields"
          role="tabpanel"
          aria-labelledby="login-tab-phone"
        >
          <template v-if="!authCodeId">
            <label class="field">
              <span class="field__label">{{ t('login.phone') }}</span>
              <input
                v-model.trim="phone"
                class="input input--mono"
                type="tel"
                name="tel"
                autocomplete="tel"
                inputmode="tel"
                placeholder="+"
                aria-describedby="login-phone-hint"
                required
                :disabled="busy"
              >
              <span id="login-phone-hint" class="field__hint">{{ t('login.phoneHint') }}</span>
            </label>
            <button
              type="button"
              class="btn btn--primary btn--block"
              data-test="send-code"
              :disabled="busy"
              @click="sendCode"
            >{{ busy ? t('login.sending') : t('login.sendCode') }}</button>
          </template>
          <template v-else>
            <p class="login__sent">
              <span>{{ t('login.codeSent', { phone: sentTo }) }}</span>
              <button type="button" class="link" :disabled="busy" @click="resetCode">{{ t('login.changePhone') }}</button>
            </p>
            <label class="field">
              <span class="field__label">{{ t('login.code') }}</span>
              <input
                ref="codeInput"
                v-model.trim="code"
                class="input input--mono input--code"
                type="text"
                name="code"
                data-test="code"
                inputmode="numeric"
                autocomplete="one-time-code"
                :maxlength="codeLength || null"
                :pattern="codeLength ? `\\d{${codeLength}}` : null"
                :style="codeLength ? { '--code-len': codeLength } : null"
                aria-describedby="login-code-hint"
                required
                :disabled="busy"
              >
              <span id="login-code-hint" class="field__hint">{{ t('login.codeHint') }}</span>
            </label>
          </template>
        </div>

        <p v-if="error" class="login__error" role="alert">{{ error }}</p>

        <button
          v-if="mode === 'email' || authCodeId"
          type="submit"
          class="btn btn--primary btn--block"
          :disabled="busy"
        >{{ busy ? t('login.busy') : t('login.submit') }}</button>
      </form>

      <figure class="trust">
        <div class="trust__route" aria-hidden="true">
          <span class="trust__node">{{ t('login.trustFrom') }}</span>
          <span class="trust__wire">
            <svg class="trust__lock" viewBox="0 0 16 16" width="14" height="14">
              <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
              <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.6" />
            </svg>
          </span>
          <span class="trust__node trust__node--broker">{{ cabinet.label }}</span>
        </div>
        <figcaption class="trust__text">{{ t('login.trust') }}</figcaption>
      </figure>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, ref } from 'vue'
import { t } from '../i18n.js'
import { DEFAULT_CABINET } from '../config.js'
import { NetworkError } from '../api/transport.js'
import { useApp } from '../composables/useApp.js'

defineProps({
  /** Rendered over the cached screen after a session expiry. */
  overlay: { type: Boolean, default: false },
})

const MODES = ['email', 'phone']
const PHONE_RE = /^\+\d{7,15}$/

const app = useApp()
const { cabinets, expired, mock } = app

const cabinetId = ref(app.session.value?.cabinetId || DEFAULT_CABINET)
const cabinet = computed(() => app.cabinetOf(cabinetId.value))
const mode = ref('email')
const loginName = ref('')
const password = ref('')
const phone = ref('')
const sentTo = ref('')
const authCodeId = ref(null)
const codeLength = ref(null)
const code = ref('')
const busy = ref(false)
const error = ref('')
const codeInput = ref(null)

function messageOf(e) {
  if (e instanceof NetworkError || !e?.message) return t('error.network')
  return e.message
}

function setMode(m, focus = false) {
  mode.value = m
  error.value = ''
  if (focus) nextTick(() => document.getElementById(`login-tab-${m}`)?.focus())
}

function resetCode() {
  authCodeId.value = null
  codeLength.value = null
  code.value = ''
  error.value = ''
}

async function sendCode() {
  if (busy.value) return
  const tel = phone.value.replace(/[\s()-]/g, '')
  if (!PHONE_RE.test(tel)) {
    error.value = t('login.phoneInvalid')
    return
  }
  busy.value = true
  error.value = ''
  try {
    const r = await app.requestCode(cabinetId.value, tel)
    authCodeId.value = r.authCodeId
    codeLength.value = Number(r.codeLength) || null
    sentTo.value = tel
    code.value = ''
    await nextTick()
    codeInput.value?.focus()
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    busy.value = false
  }
}

async function submit() {
  if (busy.value) return
  if (mode.value === 'phone' && !authCodeId.value) return sendCode()
  let creds
  if (mode.value === 'email') {
    creds = { login: loginName.value, password: password.value }
  } else {
    if (codeLength.value && code.value.length !== codeLength.value) {
      error.value = t('login.codeInvalid', { n: codeLength.value })
      return
    }
    creds = { authCodeId: authCodeId.value, code: code.value }
  }
  busy.value = true
  error.value = ''
  try {
    await app.login(cabinetId.value, creds)
  } catch (e) {
    error.value = messageOf(e)
  } finally {
    // Secrets never outlive an attempt.
    creds = null
    password.value = ''
    code.value = ''
    busy.value = false
  }
}
</script>
