/**
 * The Providers section's copy, shared by the plugin's locale registration and the Storybook
 * stories so both render the same strings.
 * @module dsh-more-providers/client/messages
 */

/** One localization lookup: a message key plus its interpolation parameters. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

const en: Record<string, string> = {
  nav: 'Providers',
  title: 'Providers',
  intro:
    'Providers come from more-providers.yaml and take effect as soon as the file is saved. Each card shows the models selectable right now and the accounts serving them; OAuth subscriptions sign in below.',
  snapshotFailed: 'Could not read the provider snapshot: {detail}',
  snapshotInvalid: 'The provider snapshot is malformed.',
  snapshotEmpty: 'This instance configures no API-key provider.',
  modelsBadge: '{n} models',
  routeError: 'Error',
  summaryProviders: '{n} providers',
  summaryAccounts: '{n} accounts',
  summaryDisabled: '{n} disabled',
  statusLoading: 'Checking…',
  instanceInvalid:
    'The configuration file is invalid: {detail} — the previous version is still serving. Fix the file and it reloads automatically.',
  instanceInvalidActive:
    'The configuration file is invalid: {detail} — v{version} is still serving. Fix the file and it reloads automatically.',
  instanceMissing:
    'The configuration file is missing: {file} — saving it applies the new version automatically.',
  refetchModels: 'Refetch',
  refetching: 'Refetching…',
  refetchFailed: 'Refetch failed: {detail}',
  modelCount: '{n} models available',
  noModels: 'No models available',
  catalogDegraded: 'Model catalog unavailable — using the static model list from the config',
  errorReason: 'Reason: {detail}',
  reasonNoCatalog: 'No usable model catalog',
  reasonAllFiltered: 'Every model was filtered out',
  reasonNoKey: 'No readable key',
  reasonAllDisabled: 'Every account is disabled',
  reasonUnknown: 'Currently unavailable',
  routeDisabled: 'disabled',
  retry: 'Retry',
  accountReady: 'ready',
  accountCooling: 'cooling down',
  accountNotReady: 'key unreadable',
  coolingForMinutes: '{minutes}m {seconds}s left',
  coolingForSeconds: '{seconds}s left',
  oauthTitle: 'OAuth sign-in',
  oauthIntro: 'Sign in with your subscription — no API key needed.',
  providersLoadFailed: 'Could not load sign-in providers: {detail}',
  providersEmpty: 'No OAuth sign-in providers are registered.',
  statusOk: 'Signed in',
  statusNotSignedIn: 'Not signed in',
  statusRefreshFailed: 'Token refresh failed: {detail} — sign in again.',
  statusUnreachable: 'Backend unreachable (network/proxy): {detail}',
  statusHttpError: 'Backend error: {detail}',
  statusUnknown: 'Not registered or unavailable.',
  refresh: 'Refresh',
  signIn: 'Sign in',
  signOut: 'Sign out',
  openBrowser: 'Open browser',
  working: 'Working…',
  signinTitle: 'Sign in',
  pasteLabel: 'If the browser cannot redirect back, paste the redirected URL or the code here:',
  submit: 'Submit',
  abandon: 'Cancel sign-in',
}

const zh: Record<string, string> = {
  nav: '供应商',
  title: '供应商',
  intro:
    'provider 来自 more-providers.yaml，保存文件即自动生效、不用重启。卡片只显示每个 provider 现在可选的模型数和账号，OAuth 订阅登录在下方。',
  snapshotFailed: '无法读取 provider 快照：{detail}',
  snapshotInvalid: 'provider 快照格式不可用。',
  snapshotEmpty: '本实例没有配置 API-key provider。',
  modelsBadge: '{n} 个模型',
  routeError: '错误',
  summaryProviders: '{n} 个 provider',
  summaryAccounts: '{n} 个账号',
  summaryDisabled: '{n} 个已禁用',
  statusLoading: '检测中…',
  instanceInvalid: '配置文件无效：{detail} —— 上一版配置仍在生效；改好保存后会自动重新加载。',
  instanceInvalidActive:
    '配置文件无效：{detail} —— 仍在使用第 {version} 版；改好保存后会自动重新加载。',
  instanceMissing: '配置文件不存在：{file} —— 保存后会自动加载新版本。',
  refetchModels: '重新获取',
  refetching: '获取中…',
  refetchFailed: '重新获取失败：{detail}',
  modelCount: '{n} 个可用模型',
  noModels: '没有可用模型',
  catalogDegraded: '模型目录不可用，使用配置中的静态模型清单',
  errorReason: '原因：{detail}',
  reasonNoCatalog: '没有可用的模型目录',
  reasonAllFiltered: '所有模型都被过滤了',
  reasonNoKey: '没有可读取的密钥',
  reasonAllDisabled: '所有账号都已禁用',
  reasonUnknown: '当前不可用',
  routeDisabled: '已禁用',
  retry: '重试',
  accountReady: '可用',
  accountCooling: '冷却中',
  accountNotReady: '密钥不可读',
  coolingForMinutes: '剩余 {minutes} 分 {seconds} 秒',
  coolingForSeconds: '剩余 {seconds} 秒',
  oauthTitle: 'OAuth 登录',
  oauthIntro: '用订阅账号登录，无需 API Key。',
  providersLoadFailed: '无法读取登录项：{detail}',
  providersEmpty: '没有已注册的 OAuth 登录项。',
  statusOk: '已登录',
  statusNotSignedIn: '未登录',
  statusRefreshFailed: '令牌刷新失败：{detail} —— 请重新登录。',
  statusUnreachable: '后端不可达（网络/代理）：{detail}',
  statusHttpError: '后端返回错误：{detail}',
  statusUnknown: '未注册或不可用。',
  refresh: '刷新',
  signIn: '登录',
  signOut: '退出登录',
  openBrowser: '打开浏览器',
  working: '进行中…',
  signinTitle: '登录',
  pasteLabel: '若浏览器无法重定向回本机，请把跳转后的 URL 或授权码粘贴到这里：',
  submit: '提交',
  abandon: '取消登录',
}

export { en, zh }

/** Resolve one message with `{name}` placeholders filled, for surfaces without the host locale service. */
export function translator(messages: Record<string, string>): Translate {
  return (key, params) => {
    const template = messages[key] ?? key
    if (params === undefined) return template
    return template.replaceAll(/\{(\w+)\}/gu, (all, name: string) => {
      const value = params[name]
      if (typeof value === 'string') return value
      const text = value === undefined ? undefined : JSON.stringify(value)
      return text ?? all
    })
  }
}
