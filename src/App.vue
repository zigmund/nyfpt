<template>
  <LoginScreen v-if="!session" />
  <template v-else>
    <div class="app" :inert="expired || null" :aria-hidden="expired ? 'true' : null">
      <section v-if="fatal" class="card" role="alert" data-test="fatal">
        <h1 class="label">{{ t('app.name') }}</h1>
        <p>{{ fatal }}</p>
        <div class="row">
          <button type="button" class="btn btn--primary" :disabled="retrying" @click="retry">{{ t('error.retry') }}</button>
          <button type="button" class="btn" @click="logout">{{ t('settings.logout') }}</button>
        </div>
      </section>
      <SettingsScreen v-else-if="route === '/settings'" />
      <MainPlaceholder v-else :view="route === '/compare' ? 'compare' : 'main'" />
    </div>
    <LoginScreen v-if="expired" overlay />
  </template>
</template>

<script setup>
import { ref } from 'vue'
import LoginScreen from './components/LoginScreen.vue'
import SettingsScreen from './components/SettingsScreen.vue'
import MainPlaceholder from './components/MainPlaceholder.vue'
import { t } from './i18n.js'
import { useApp } from './composables/useApp.js'

const app = useApp()
const { session, expired, fatal, route, logout } = app

const retrying = ref(false)
async function retry() {
  retrying.value = true
  try {
    await app.retry()
  } finally {
    retrying.value = false
  }
}
</script>
