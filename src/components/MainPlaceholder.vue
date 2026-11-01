<!-- Temporary main / compare screen so the shell is testable; Task 9 replaces it. -->
<template>
  <div class="screen">
    <header class="topbar">
      <a v-if="view === 'compare'" class="icon-btn" href="#/" :aria-label="t('nav.back')">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </a>
      <h1 class="topbar__title">{{ view === 'compare' ? t('main.compare') : t('app.name') }}</h1>
      <a v-if="view === 'main'" class="icon-btn topbar__end" href="#/settings" :aria-label="t('nav.settings')">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </a>
    </header>

    <section v-if="view === 'compare'" class="card">
      <p class="card__hint">{{ t('main.compareSoon') }}</p>
    </section>

    <section v-else class="card" aria-live="polite">
      <p class="status">
        <span class="dot" :class="{ 'dot--on': live.isLive.value }" aria-hidden="true" />
        {{ live.isLive.value ? t('main.live') : t('main.closed') }}
      </p>
      <template v-if="positions">
        <p class="big num">{{ money(total, { hide: prefs.hide }) }}</p>
        <p class="card__hint num">{{ t('main.positions', { n: count }) }}</p>
      </template>
      <template v-else>
        <p class="big skel">&nbsp;</p>
        <p class="card__hint">{{ t('main.loading') }}</p>
      </template>
      <p v-if="updated" class="card__hint num">{{ t('status.updated', { time: updated }) }}</p>
      <p v-if="errorNames" class="warn">{{ t('main.errors', { names: errorNames }) }}</p>
      <a class="link" href="#/compare">{{ t('main.compare') }}</a>
    </section>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { t } from '../i18n.js'
import { money } from '../format.js'
import { useApp } from '../composables/useApp.js'

defineProps({
  view: { type: String, default: 'main', validator: (v) => ['main', 'compare'].includes(v) },
})

const { state, live, prefs } = useApp()
const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

const positions = computed(() => state.value?.positions || null)
const count = computed(() => positions.value.filter((r) => r.kind === 'position').length)
const total = computed(() => positions.value.reduce((s, r) => s + (Number(r.value) || 0), 0))
const updated = computed(() => (state.value?.updatedAt ? time.format(state.value.updatedAt) : ''))
const errorNames = computed(() => Object.keys(state.value?.errors || {}).join(', '))
</script>
