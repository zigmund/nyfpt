// UI strings (English only). Later tasks add their keys here.
const en = {
  'app.name': 'Portfolio',
  'status.updated': 'Updated {time}',
  'error.usdOnly': 'Only USD accounts are supported for now.',
  'error.network': "Can't reach the broker. Check your connection and try again.",
  'error.noUser': "The broker didn't return an account ID. Try logging in again.",

  'nav.settings': 'Settings',
  'nav.back': 'Back',

  'login.title': 'Log in with your broker account',
  'login.cabinet': 'Broker site',
  'login.method': 'Login method',
  'login.tabEmail': 'Email',
  'login.tabPhone': 'Phone',
  'login.login': 'Email or login',
  'login.password': 'Password',
  'login.phone': 'Phone number',
  'login.phoneHint': 'International format, starting with +',
  'login.phoneInvalid': 'Enter the number in international format, starting with +.',
  'login.sendCode': 'Send code',
  'login.sending': 'Sending…',
  'login.code': 'Code',
  'login.codeHint': 'The code may arrive as a push notification in the broker app',
  'login.codeInvalid': 'Enter the {n}-digit code.',
  'login.codeSent': 'Code sent to {phone}',
  'login.changePhone': 'Change number',
  'login.submit': 'Log in',
  'login.busy': 'Logging in…',
  'login.trust': 'Your password goes directly from this browser to the broker. This site never receives or stores it.',
  'login.trustFrom': 'This browser',
  'login.expired': 'Your session has expired. Log in again to update the data.',
  'login.mock': 'Mock mode: any login and password work.',

  'main.loading': 'Loading positions…',
  'main.positions': '{n} positions',
  'main.live': 'Live quotes',
  'main.closed': 'Markets closed',
  'main.compare': 'Compare with indices',
  'main.compareSoon': 'The comparison screen is coming soon.',
  'main.errors': 'Some data could not be updated: {names}',

  'settings.title': 'Settings',
  'settings.account': 'Account',
  'settings.cabinet': 'Broker site',
  'settings.userId': 'User ID',
  'settings.display': 'Display',
  'settings.hide': 'Hide amounts',
  'settings.hideHint': 'Shows *** instead of dollar amounts. Percentages and prices stay visible.',
  'settings.data': 'Data on this device',
  'settings.clearCache': 'Clear cache',
  'settings.clearCacheHint': 'Deletes the saved data for this account. It loads again from the broker.',
  'settings.cleared': 'Cache cleared',
  'settings.logout': 'Log out',
  'settings.logoutHint': 'Forgets the broker session on this device. Saved data stays until you clear the cache.',
  'settings.version': 'Version {v}',
}

// t(key, vars) -> string; replaces {name}, unknown key returns the key
export function t(key, vars) {
  const s = Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
}
