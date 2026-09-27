/**
 * Proxy-aware HTTP transport for the OpenAI OAuth adapter.
 *
 * Node's global `fetch` (undici) does not read the operating system proxy or
 * the standard `HTTPS_PROXY`/`HTTP_PROXY` environment variables by default, so
 * a direct fetch to `chatgpt.com` would hang behind a proxy. This module
 * resolves an outbound proxy the same way the Codex CLI does — explicit
 * config, then environment, then the operating system proxy (macOS, Windows,
 * or Linux) — and returns an undici `fetch` bound to the matching `ProxyAgent`.
 *
 * Derived from werifu/dsh-oai-oauth (MIT) — see THIRD-PARTY-NOTICE.md.
 *
 * @module dsh-openai-oauth/transport
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A proxy-aware fetch compatible with the DOM `fetch` shape. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** One-shot cache for the detected system proxy (`undefined` = not resolved yet, `null` = none). */
let detectedProxy: string | null | undefined

/**
 * Run a command best-effort and return its stdout, or `null` when the command
 * is missing, exits non-zero, or times out. Proxy detection never throws.
 */
async function run(
  cmd: string,
  args: string[] = [],
  opts: { timeout?: number } = {},
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: opts.timeout ?? 3000 })
    return stdout
  } catch {
    return null
  }
}

/** `host:port` pair → proxy URL, guarding empty/loopback/wildcard hosts. */
function buildProxyUrl(
  host: string | null | undefined,
  port: string | null | undefined,
): string | null {
  if (!host || !port || host === '0.0.0.0' || host === '::') return null
  return `http://${host}:${port}`
}

/** Normalize a Windows/`host:port`/URL address into a proxy URL. */
function normalizeAddress(addr: string | null | undefined): string | null {
  if (!addr) return null
  const trimmed = addr.trim()
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '<local>') return null
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

// --- macOS (scutil) ---------------------------------------------------------

/**
 * Parse `scutil --proxy` output into a proxy URL. Prefers the HTTPS proxy,
 * then the HTTP proxy; ignores disabled or wildcard entries.
 */
export function parseMacosProxy(stdout: string): string | null {
  let host: string | undefined
  let port: string | undefined
  if (/HTTPSEnable\s*:\s*1/.test(stdout)) {
    host = /HTTPSProxy\s*:\s*(\S+)/.exec(stdout)?.[1]
    port = /HTTPSPort\s*:\s*(\d+)/.exec(stdout)?.[1]
  }
  if ((!host || !port) && /HTTPEnable\s*:\s*1/.test(stdout)) {
    host = /HTTPProxy\s*:\s*(\S+)/.exec(stdout)?.[1]
    port = /HTTPPort\s*:\s*(\d+)/.exec(stdout)?.[1]
  }
  return buildProxyUrl(host, port)
}

async function detectMacosSystemProxy(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  const stdout = await run('scutil', ['--proxy'])
  return stdout === null ? null : parseMacosProxy(stdout)
}

// --- Windows (registry) -----------------------------------------------------

const WINDOWS_INTERNET_SETTINGS =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** Parse a `REG_DWORD` value (e.g. `0x1`) from `reg query` output. */
export function parseRegDword(stdout: string): number | null {
  const match = /REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(stdout)
  return match ? parseInt(match[1]!, 16) : null
}

/** Parse a string (`REG_SZ`/`REG_EXPAND_SZ`) value from `reg query` output. */
export function parseRegString(stdout: string): string | null {
  const match = /(?:REG_SZ|REG_EXPAND_SZ)\s+(.+?)\s*$/m.exec(stdout)
  return match?.[1]?.trim() ?? null
}

/**
 * Parse the Windows `ProxyServer` value, which may be a bare `host:port`, a
 * `proto=host:port;...` list, or the reverse `host:port=proto,proto` form.
 * Prefers the `https` entry, then `http`, then the bare address.
 */
export function parseWindowsProxyServer(value: string): string | null {
  if (!value) return null
  let bare: string | null = null
  let http: string | null = null
  let https: string | null = null
  for (const raw of value.split(';')) {
    const part = raw.trim()
    if (!part || part === '<local>') continue
    const eq = part.indexOf('=')
    if (eq === -1) {
      bare = part
      continue
    }
    const left = part.slice(0, eq).trim().toLowerCase()
    const right = part.slice(eq + 1).trim()
    // Reverse form: "server:port=http,https".
    if (/^[a-z][a-z0-9]*(\s*,\s*[a-z][a-z0-9]*)*$/i.test(right) && !/^[a-z]+$/.test(left)) {
      const protos = right.split(',').map((s) => s.trim().toLowerCase())
      if (https === null && protos.includes('https')) https = left
      if (http === null && protos.includes('http')) http = left
      continue
    }
    if (left === 'https') https = right
    else if (left === 'http') http = right
  }
  return normalizeAddress(https ?? http ?? bare)
}

async function detectWindowsSystemProxy(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  const enableOut = await run('reg', ['query', WINDOWS_INTERNET_SETTINGS, '/v', 'ProxyEnable'])
  if (enableOut === null || parseRegDword(enableOut) !== 1) return null
  const serverOut = await run('reg', ['query', WINDOWS_INTERNET_SETTINGS, '/v', 'ProxyServer'])
  if (serverOut === null) return null
  return parseWindowsProxyServer(parseRegString(serverOut) ?? '')
}

// --- Linux (GNOME gsettings / KDE) -------------------------------------------

/** Parse a gsettings string value (`'quoted'`) into a plain string. */
export function parseGsettingsString(stdout: string): string | null {
  const match = /^'((?:[^'\\]|\\.)*)'\s*$/.exec(stdout.trim())
  if (!match) return null
  return match[1]!.replace(/\\(.)/g, '$1')
}

/** Parse a gsettings integer value into a number. */
export function parseGsettingsInt(stdout: string): number | null {
  const match = /^-?\d+\s*$/.exec(stdout.trim())
  return match ? parseInt(match[0], 10) : null
}

async function detectGnomeSystemProxy(): Promise<string | null> {
  if (process.platform !== 'linux') return null
  const modeOut = await run('gsettings', ['get', 'org.gnome.system.proxy', 'mode'])
  if (modeOut === null || parseGsettingsString(modeOut) !== 'manual') return null

  const httpsHost = parseGsettingsString(
    (await run('gsettings', ['get', 'org.gnome.system.proxy.https', 'host'])) ?? '',
  )
  const httpsPort = parseGsettingsInt(
    (await run('gsettings', ['get', 'org.gnome.system.proxy.https', 'port'])) ?? '',
  )
  const https = buildProxyUrl(httpsHost, httpsPort === null ? null : String(httpsPort))
  if (https) return https

  const httpHost = parseGsettingsString(
    (await run('gsettings', ['get', 'org.gnome.system.proxy.http', 'host'])) ?? '',
  )
  const httpPort = parseGsettingsInt(
    (await run('gsettings', ['get', 'org.gnome.system.proxy.http', 'port'])) ?? '',
  )
  return buildProxyUrl(httpHost, httpPort === null ? null : String(httpPort))
}

/** KDE `ProxyType` values: 0=none, 1=manual, 2=PAC, 3=WPAD, 4=env, 5=auto. */
const KDE_KIOSLAVERC_ARGS = ['--file', 'kioslaverc', '--group', 'Proxy Settings']

/**
 * Read a manual KDE proxy. Returns a proxy URL when configured, `null` when the
 * config utility runs but reports "no proxy", or `undefined` when the command
 * is unavailable (so the caller can try the next `kreadconfig` version).
 */
async function kdeProxy(cmd: string): Promise<string | null | undefined> {
  const typeOut = await run(cmd, [...KDE_KIOSLAVERC_ARGS, '--key', 'ProxyType'])
  if (typeOut === null) return undefined
  if (parseInt(typeOut.trim(), 10) !== 1) return null
  const https = await run(cmd, [...KDE_KIOSLAVERC_ARGS, '--key', 'httpsProxy'])
  if (https && https.trim()) return normalizeAddress(https.trim())
  const http = await run(cmd, [...KDE_KIOSLAVERC_ARGS, '--key', 'httpProxy'])
  return http && http.trim() ? normalizeAddress(http.trim()) : null
}

async function detectKdeSystemProxy(): Promise<string | null> {
  // Plasma 6 ships `kreadconfig6`; Plasma 5 uses `kreadconfig5`.
  for (const cmd of ['kreadconfig6', 'kreadconfig5']) {
    const proxy = await kdeProxy(cmd)
    if (proxy) return proxy
    if (proxy === null) return null
  }
  return null
}

async function detectLinuxSystemProxy(): Promise<string | null> {
  if (process.platform !== 'linux') return null
  return (await detectGnomeSystemProxy()) ?? (await detectKdeSystemProxy())
}

// --- public API -------------------------------------------------------------

/**
 * Detect the operating system proxy (macOS `scutil`, Windows registry, or
 * Linux GNOME/KDE settings). Best-effort: any failure resolves to `null`
 * (direct connection).
 */
async function detectSystemProxy(): Promise<string | null> {
  if (process.platform === 'darwin') return detectMacosSystemProxy()
  if (process.platform === 'win32') return detectWindowsSystemProxy()
  if (process.platform === 'linux') return detectLinuxSystemProxy()
  return null
}

/**
 * Resolve the outbound proxy URL: explicit config, then environment, then the
 * operating system proxy.
 */
export async function resolveProxy(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (explicit) return explicit
  if (detectedProxy !== undefined) return detectedProxy
  const fromEnv =
    env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY || env.http_proxy ||
    env.ALL_PROXY || env.all_proxy
  detectedProxy = fromEnv ? fromEnv : await detectSystemProxy()
  return detectedProxy
}

/**
 * Build an undici fetch bound to the resolved proxy, or the plain undici fetch
 * for a direct connection. undici's own `fetch` is used (not the global) so
 * the `dispatcher` comes from the same undici instance.
 */
export async function createFetch(proxyUrl?: string): Promise<FetchLike> {
  const proxy = await resolveProxy(proxyUrl)
  if (!proxy) return undiciFetch as unknown as FetchLike
  const dispatcher = new ProxyAgent({ uri: proxy })
  type UndiciInit = Parameters<typeof undiciFetch>[1]
  return ((url: string, init?: RequestInit) =>
    undiciFetch(url, { ...init, dispatcher } as UndiciInit)) as FetchLike
}

/**
 * Parse a response body as JSON, but never let a proxy/Cloudflare HTML page
 * surface as a raw `Unexpected token '<'` error. Non-JSON or unparseable
 * bodies raise a descriptive error with a short body snippet instead.
 */
export async function readJson(response: Response, what: string): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  const trimmed = text.trim()
  if (trimmed === '') throw new Error(`${what} returned an empty body`)
  const looksJson = contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')
  if (!looksJson) {
    throw new Error(`${what} returned a non-JSON response (${contentType || 'unknown type'}): ${snippet(trimmed)}`)
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    throw new Error(`${what} returned invalid JSON: ${snippet(trimmed)}`)
  }
}

function snippet(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, 200)
}
