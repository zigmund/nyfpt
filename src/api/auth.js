import { callLegacy, BrokerError } from './transport.js'

function toSession(data, cmd) {
  if (!data?.SID) {
    throw new BrokerError(data?.error || data?.errMsg || 'Login failed', { code: data?.code ?? null, cmd })
  }
  return { sid: data.SID, userId: data.userId ?? data.user_id ?? null }
}

export async function loginByPassword({ cabinet, login, password, fetchImpl }) {
  const data = await callLegacy({
    rest: cabinet.rest, cmd: 'authByLogin', fetchImpl,
    params: { login, password, rememberMe: 1, viewOnlyMode: true },
  })
  return toSession(data, 'authByLogin')
}

export async function requestPhoneCode({ cabinet, phone, fetchImpl }) {
  const data = await callLegacy({ rest: cabinet.rest, cmd: 'getAuthSms', params: { tel: phone }, fetchImpl })
  if (!data?.auth_code_id) throw new BrokerError('Could not request a code', { cmd: 'getAuthSms' })
  return { authCodeId: data.auth_code_id, codeLength: data.auth_code_length }
}

export async function loginByPhoneCode({ cabinet, authCodeId, code, fetchImpl }) {
  const data = await callLegacy({
    rest: cabinet.rest, cmd: 'authBySms', fetchImpl,
    params: { authCodeId, sms: code, rememberMe: 1, viewOnlyMode: true },
  })
  return toSession(data, 'authBySms')
}
