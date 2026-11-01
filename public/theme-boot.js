// Applies the saved theme before the first paint: <html data-theme>, meta theme-color and color-scheme.
// Classic blocking script (CSP forbids inline scripts). The app (useApp.js) takes over after boot.
// Colours must equal THEME_BG in src/composables/useApp.js and --c-bg in app.css (tests check).
;(function () {
  try {
    var BG = { light: '#F1F3F2', dark: '#0D0F0E' }
    var theme = 'light'
    try {
      var p = JSON.parse(localStorage.getItem('nyfpt.prefs') || 'null')
      if (p && (p.theme === 'light' || p.theme === 'dark' || p.theme === 'system')) theme = p.theme
    } catch (e) {
      // storage unavailable or broken JSON: the app default (light)
    }
    if (theme === 'system') {
      theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    var d = document
    d.documentElement.setAttribute('data-theme', theme)
    var tc = d.querySelector('meta[name="theme-color"]')
    if (tc) tc.setAttribute('content', BG[theme])
    var cs = d.querySelector('meta[name="color-scheme"]')
    if (cs) cs.setAttribute('content', theme)
  } catch (e) {
    // never block the page
  }
})()
