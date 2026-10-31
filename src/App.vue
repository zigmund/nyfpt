<template>
  <LoginScreen v-if="!session" />
  <template v-else>
    <div class="app" :inert="expired || null" :aria-hidden="expired ? 'true' : null">
      <SettingsScreen v-if="route === '/settings'" />
      <MainPlaceholder v-else :view="route === '/compare' ? 'compare' : 'main'" />
    </div>
    <LoginScreen v-if="expired" overlay />
  </template>
</template>

<script setup>
import LoginScreen from './components/LoginScreen.vue'
import SettingsScreen from './components/SettingsScreen.vue'
import MainPlaceholder from './components/MainPlaceholder.vue'
import { useApp } from './composables/useApp.js'

const { session, expired, route } = useApp()
</script>
