<template>
  <div class="screen screen--narrow">
    <header class="topbar">
      <a class="icon-btn" href="#/" :aria-label="t('nav.back')">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </a>
      <h1 class="topbar__title">{{ t('settings.title') }}</h1>
    </header>

    <section class="card" aria-labelledby="set-account">
      <h2 id="set-account" class="label">{{ t('settings.account') }}</h2>
      <dl class="kv">
        <template v-if="app.cabinets.length > 1">
          <dt>{{ t('settings.cabinet') }}</dt>
          <dd>{{ cabinet.label }}</dd>
        </template>
        <dt>{{ t('settings.userId') }}</dt>
        <dd class="num">{{ session?.userId ?? '—' }}</dd>
      </dl>
    </section>

    <section class="card" aria-labelledby="set-display">
      <h2 id="set-display" class="label">{{ t('settings.display') }}</h2>
      <div class="field">
        <span id="set-theme" class="toggle__title">{{ t('settings.theme') }}</span>
        <div class="seg" role="group" aria-labelledby="set-theme">
          <button
            v-for="o in THEME_OPTIONS" :key="o.value" type="button" class="seg__btn"
            :aria-pressed="prefs.theme === o.value ? 'true' : 'false'" :data-test="`theme-${o.value}`"
            @click="prefs.theme = o.value"
          >{{ t(o.label) }}</button>
        </div>
      </div>
      <label class="toggle">
        <span class="toggle__text">
          <span class="toggle__title">{{ t('settings.hide') }}</span>
          <span class="toggle__hint">{{ t('settings.hideHint') }}</span>
        </span>
        <input v-model="prefs.hide" class="toggle__input" type="checkbox" role="switch">
        <span class="toggle__track" aria-hidden="true" />
      </label>
    </section>

    <section class="card" aria-labelledby="set-data">
      <h2 id="set-data" class="label">{{ t('settings.data') }}</h2>
      <p class="card__hint">{{ t('settings.clearCacheHint') }}</p>
      <div class="row">
        <button type="button" class="btn btn--danger" :disabled="clearing" @click="clear">{{ t('settings.clearCache') }}</button>
        <span class="row__status" role="status">{{ clearMsg }}</span>
      </div>
    </section>

    <section class="card">
      <p class="card__hint">{{ t('settings.logoutHint') }}</p>
      <button type="button" class="btn btn--block" @click="logout">{{ t('settings.logout') }}</button>
    </section>

    <p class="footnote num">{{ t('settings.version', { v: version }) }}</p>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { t } from '../i18n.js'
import { useApp } from '../composables/useApp.js'

const THEME_OPTIONS = [
  { value: 'system', label: 'settings.themeSystem' },
  { value: 'light', label: 'settings.themeLight' },
  { value: 'dark', label: 'settings.themeDark' },
]

const app = useApp()
const { session, prefs, logout } = app
const cabinet = computed(() => app.cabinetOf(session.value?.cabinetId))
const version = import.meta.env.VITE_APP_VERSION || 'dev'

const clearing = ref(false)
const clearMsg = ref('')

async function clear() {
  clearing.value = true
  clearMsg.value = ''
  try {
    await app.clearCache()
    clearMsg.value = t('settings.cleared')
  } catch {
    clearMsg.value = t('settings.clearFailed')
  } finally {
    clearing.value = false
  }
}
</script>
