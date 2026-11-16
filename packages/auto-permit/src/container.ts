/**
 * Container-engine boundary for the approval chain.
 *
 * This is NOT a shell parser and NOT a Podman parser. It is a conservative
 * token scanner over one bash input that answers two questions the approval
 * chain needs, because container commands are the first family whose effects
 * live outside the command string:
 *
 * 1. {@link containerRisk} — shapes that always go to the human dialog and
 *    never reach the judge: compose (its resolved effects are invisible),
 *    remote/unknown engine targets, privilege/device/host-namespace access,
 *    engine sockets, home/root/credential/config mounts, lifecycle or
 *    deletion of resources this task did not create, image pushes, and host
 *    engine configuration. Same role as the irreversibility shapes in
 *    `./rules.ts`, which is why it is folded into the exported `isHighRisk`
 *    (cmd-permit's shared oracle therefore enforces the same boundary).
 *
 * 2. {@link isMutableFileDependent} — commands whose effect can change while
 *    the command string stays identical. A container engine reads
 *    Containerfiles, compose files, image tags, and existing container state;
 *    a shell script is a file that can be edited. Exact-repeat memory must
 *    re-judge them every time instead of replaying an earlier approval.
 *
 * False positives cost a human dialog or one extra judge call, so the
 * scanner errs toward deferring. A clean scan is not a proof of safety: the
 * judge still decides, and the human still owns anything unusual.
 *
 * @module dsh-auto-permit/container
 */

/** Any bash input that names a supported container engine. */
const ENGINE = /\b(?:podman|docker)\b/u

/** Engine binaries that resolve a compose file instead of a visible argv. */
const COMPOSE_BINARY = /^(?:podman|docker)-compose$/u

/** One shell segment; splitting is deliberately coarse (over-splitting is safe). */
const SEGMENT_SEPARATOR = /(?:&&|\|\||[;|\n])/u

/**
 * Engine-level options that consume the following token. The list only needs
 * to cover options that may precede the subcommand; an unrecognized option is
 * treated as boolean, which can only make the scan less strict, never stricter
 * — the judge and the human remain the decision makers.
 */
const VALUE_OPTIONS = new Set([
  '--root',
  '--runroot',
  '--storage-driver',
  '--storage-opt',
  '--runtime',
  '--runtime-flag',
  '--tmpdir',
  '--events-backend',
  '--cgroup-manager',
  '--conmon',
  '--identity',
  '--log-level',
  '--url',
  '--connection',
  '--context',
  '--config',
  '--hooks-dir',
  '-c',
  '-H',
  '--host',
])

/** Risk labels, shown to the user in the notice row. */
export const CONTAINER_RISKS = {
  compose: 'compose or manifest invocation',
  remote: 'remote or unknown engine target',
  privilege: 'privilege or device access',
  namespace: 'host namespace access',
  socket: 'engine socket',
  mount: 'sensitive host path exposure',
  lifecycle: 'existing container lifecycle',
  prune: 'volume or global prune',
  push: 'image push',
  hostConfig: 'host engine configuration',
} as const

const LIFECYCLE = new Set([
  'exec',
  'attach',
  'stop',
  'kill',
  'rm',
  'restart',
  'start',
  'pause',
  'unpause',
  'cp',
  'commit',
])

/**
 * Podman's first-level command groups. The engine accepts both the flat
 * alias and the grouped spelling (`podman stop` / `podman container stop`),
 * so the nested command is what the risk table must classify.
 */
const COMMAND_GROUPS = new Set([
  'container',
  'image',
  'pod',
  'volume',
  'network',
  'manifest',
  'secret',
  'artifact',
  'node',
  'service',
  'stack',
  'plugin',
  'builder',
  'buildx',
  'context',
])

/** Strip shell quotes a token may carry (the shell removes them before exec). */
function bare(token: string): string {
  return token.trim().replaceAll(/^["']+|["']+$/gu, '')
}

/** Mount sources may be quoted per component; drop every quote there. */
function barePath(value: string): string {
  return value.replaceAll(/["']/gu, '')
}

function engineNameOf(token: string): string | undefined {
  const name = bare(token).replaceAll(/^[<($]+|[)>)]+$/gu, '')
  const base = name.split('/').pop() ?? name
  if (base === 'podman' || base === 'docker') return base
  if (base === 'podman-remote') return base
  if (COMPOSE_BINARY.test(base)) return base
  return undefined
}

function segmentsOf(command: string): string[][] {
  return command
    .split(SEGMENT_SEPARATOR)
    .map((segment) => segment.trim().split(/\s+/u).filter(Boolean))
}

/** The first non-option token after an engine, skipping option values. */
function subcommandOf(
  tokens: readonly string[],
  engineAt: number,
): { name: string; at: number } | undefined {
  for (let i = engineAt + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) return undefined
    const clean = bare(token)
    if (clean.startsWith('-')) {
      const equals = clean.indexOf('=')
      const name = equals === -1 ? clean : clean.slice(0, equals)
      if (equals === -1 && VALUE_OPTIONS.has(name)) i += 1
      continue
    }
    return { name: clean, at: i }
  }
  return undefined
}

function hasOption(tokens: readonly string[], name: string): boolean {
  return tokens.some((token) => {
    const clean = bare(token)
    return clean === name || clean.startsWith(`${name}=`)
  })
}

function optionValues(tokens: readonly string[], name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue
    const clean = bare(token)
    if (clean === name && tokens[i + 1] !== undefined) values.push(bare(tokens[i + 1] ?? ''))
    else if (clean.startsWith(`${name}=`)) values.push(bare(clean.slice(name.length + 1)))
  }
  return values
}

function isHostTarget(value: string | undefined): boolean {
  if (value === undefined) return false
  return value.split(',').some((part) => part === 'host' || part.startsWith('container:'))
}

function securityRelaxed(value: string | undefined): boolean {
  if (value === undefined) return false
  return /^(?:seccomp|apparmor|label|systempaths)=/u.test(value)
}

/** Host paths the input exposes to a container, best effort. */
function hostPathSources(tokens: readonly string[]): string[] {
  const sources: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token === undefined) continue
    const clean = bare(token)
    const equals = clean.indexOf('=')
    const name = equals === -1 ? clean : clean.slice(0, equals)
    if (name === '--env-file') {
      const value = equals === -1 ? tokens[i + 1] : clean.slice(equals + 1)
      if (value !== undefined) sources.push(barePath(value))
      continue
    }
    if (name === '--mount' || name === '--secret') {
      const spec = equals === -1 ? tokens[i + 1] : clean.slice(equals + 1)
      if (spec === undefined) continue
      const parts = spec.split(',')
      const source =
        parts.find((part) => /^(?:source|src)=/u.test(part))?.replace(/^(?:source|src)=/u, '') ??
        (name === '--mount' ? parts[0]?.split(':')[0] : undefined)
      if (source !== undefined) sources.push(barePath(source))
      continue
    }
    // pflag shorthand value: `-vSOURCE:DEST`, `-v=SOURCE`, and the same
    // option grouped behind boolean shorthands (`-itvSOURCE:DEST`,
    // `-itv SOURCE:DEST`). All name the same mount as `-v SOURCE:DEST`.
    const shortVolume = clean.startsWith('--') ? null : /^-[A-Za-z]*v(.*)$/u.exec(clean)
    if (shortVolume !== null) {
      const attached = (shortVolume[1] ?? '').replace(/^=/u, '')
      const value = attached !== '' ? attached : tokens[i + 1]
      if (value !== undefined) sources.push(barePath(value.split(':')[0] ?? ''))
      continue
    }
    if (name !== '--volume' && name !== '--rootfs') continue
    const value = equals === -1 ? tokens[i + 1] : clean.slice(equals + 1)
    if (value === undefined) continue
    sources.push(barePath(value.split(':')[0] ?? ''))
  }
  return sources
}

/**
 * A host path whose exposure to a container bypasses the project boundary:
 * the home or host root, credential/config directories, and engine state.
 * Workspace paths (including the project under /home) are intentionally not
 * here — those are the judge's call under the workspace boundary.
 */
function sensitiveSource(raw: string): boolean {
  if (raw === '') return false
  // Strip the slash spellings that don't change the named directory
  // (`/home/u/`, `//home/u`, `/home/u/.`). A `..` segment is not resolved
  // textually (symlinks decide it), so it goes to the human.
  const collapsed = raw.replaceAll(/\/{2,}/gu, '/')
  const trimmed = collapsed.length > 1 ? collapsed.replace(/\/+$/u, '') : collapsed
  const value = trimmed === '' ? '/' : trimmed
  if (/(?:^|\/)\.\.(?:\/|$)/u.test(value)) return true
  const source = value.replaceAll(/\/\.(?=\/|$)/gu, '')
  // `/.` normalizes to the host root.
  if (source === '') return true
  if (source === '~' || source.startsWith('~/')) return true
  if (/^\$(?:\{HOME\}|HOME)(?:\/|$)/u.test(source)) return true
  if (source === '/root' || source.startsWith('/root/')) return true
  if (source === '/') return true
  if (/^\/home\/[^/]+$/u.test(source) || /^\/Users\/[^/]+$/u.test(source)) return true
  if (
    /^\/run\/user\/[^/]+$/u.test(source) ||
    (source.startsWith('/run/user/') && source.endsWith('/podman'))
  ) {
    return true
  }
  if (source === '/dev' || source.startsWith('/dev/')) return true
  if (source === '/proc' || source.startsWith('/proc/')) return true
  if (source === '/sys' || source.startsWith('/sys/')) return true
  if (
    /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.config|\.netrc|\.git-credentials|\.password-store)(?:\/|$)/u.test(
      source,
    )
  ) {
    return true
  }
  if (source.includes('/.config/containers') || source.includes('/.local/share/containers'))
    return true
  if (source.includes('/var/lib/containers') || source.includes('/etc/containers')) return true
  if (source.includes('podman.sock') || source.includes('docker.sock')) return true
  return false
}

function segmentRisk(tokens: readonly string[]): string | undefined {
  for (const token of tokens) {
    if (/^(?:CONTAINER_HOST|CONTAINER_CONNECTION|DOCKER_HOST|DOCKER_CONTEXT)=/u.test(bare(token))) {
      return CONTAINER_RISKS.remote
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const engine = engineNameOf(tokens[i] ?? '')
    if (engine === undefined) continue
    if (engine === 'podman-remote') return CONTAINER_RISKS.remote
    if (COMPOSE_BINARY.test(engine)) return CONTAINER_RISKS.compose

    const sub = subcommandOf(tokens, i)
    if (sub !== undefined) {
      const next = bare(tokens[sub.at + 1] ?? '')
      // Both spellings of a grouped command classify the same way:
      // `podman container stop` / `podman stop`, `podman image push` /
      // `podman push`, `podman container prune` / `podman system prune`.
      const action = COMMAND_GROUPS.has(sub.name) ? next : sub.name
      if (sub.name === 'compose' || action === 'compose') return CONTAINER_RISKS.compose
      if (sub.name === 'kube' && (next === 'play' || next === 'down'))
        return CONTAINER_RISKS.compose
      if (sub.name === 'play' && next === 'kube') return CONTAINER_RISKS.compose
      if (action === 'push') return CONTAINER_RISKS.push
      if (action === 'generate') return CONTAINER_RISKS.hostConfig
      if (action === 'prune') return CONTAINER_RISKS.prune
      if (action === 'rm' || action === 'remove') {
        // `podman volume rm` destroys host-side volume data; every other
        // grouped `rm` deletes an existing container/pod/network/manifest/
        // secret/artifact.
        return sub.name === 'volume' ? CONTAINER_RISKS.prune : CONTAINER_RISKS.lifecycle
      }
      if (LIFECYCLE.has(action)) return CONTAINER_RISKS.lifecycle
      if (sub.name === 'system') {
        if (next === 'prune' || next === 'reset') return CONTAINER_RISKS.prune
        if (next === 'service' || next === 'connection') return CONTAINER_RISKS.hostConfig
      }
      if (
        sub.name === 'machine' &&
        ['init', 'rm', 'rmi', 'reset', 'start', 'stop', 'set', 'ssh'].includes(next)
      ) {
        return CONTAINER_RISKS.hostConfig
      }
      if (
        sub.name === 'swarm' &&
        ['init', 'join', 'leave', 'update', 'unlock', 'unlock-key'].includes(next)
      ) {
        return CONTAINER_RISKS.hostConfig
      }
    }

    // `--remote`/`--url`/`--connection`/`--context` and `-c`/`-H` are engine
    // GLOBAL options: only the tokens before the subcommand belong to this
    // engine (`bash -c "podman …"` must not look like a connection target).
    const globalTokens = tokens.slice(i + 1, sub?.at ?? tokens.length)
    if (
      hasOption(globalTokens, '--remote') ||
      hasOption(globalTokens, '--url') ||
      hasOption(globalTokens, '--connection') ||
      hasOption(globalTokens, '--context')
    ) {
      return CONTAINER_RISKS.remote
    }
    if (engine === 'podman' && optionValues(globalTokens, '-c').length > 0)
      return CONTAINER_RISKS.remote
    if (
      engine === 'docker' &&
      (optionValues(globalTokens, '-H').length > 0 ||
        optionValues(globalTokens, '--host').length > 0)
    ) {
      return CONTAINER_RISKS.remote
    }

    if (hasOption(tokens, '--hooks-dir')) return CONTAINER_RISKS.hostConfig

    if (
      hasOption(tokens, '--privileged') ||
      hasOption(tokens, '--cap-add') ||
      hasOption(tokens, '--device') ||
      hasOption(tokens, '--ssh') ||
      optionValues(tokens, '--security-opt').some((value) => securityRelaxed(value))
    ) {
      return CONTAINER_RISKS.privilege
    }

    for (const flag of [
      '--network',
      '--net',
      '--pid',
      '--ipc',
      '--uts',
      '--userns',
      '--cgroupns',
    ]) {
      if (optionValues(tokens, flag).some((value) => isHostTarget(value)))
        return CONTAINER_RISKS.namespace
    }

    if (
      hasOption(tokens, '--volumes-from') ||
      hostPathSources(tokens).some((source) => sensitiveSource(source))
    ) {
      return CONTAINER_RISKS.mount
    }
  }
  return undefined
}

/**
 * Classify one bash input's container boundary.
 *
 * @param command - the complete bash input.
 * @returns a risk label when the input must go straight to the human dialog;
 *   undefined when the judge may consider it.
 */
export function containerRisk(command: string): string | undefined {
  if (!ENGINE.test(command)) return undefined
  if (/\b(?:podman|docker)\.sock\b/u.test(command)) return CONTAINER_RISKS.socket
  for (const tokens of segmentsOf(command)) {
    const risk = segmentRisk(tokens)
    if (risk !== undefined) return risk
  }
  return undefined
}

/**
 * Commands that must be re-judged on every request instead of replayed from
 * exact-repeat memory: anything invoking a container engine (mutable files
 * and engine state) and anything executing a shell-script file. Detection is
 * heuristic and may over-trigger; over-triggering only costs a judge call.
 *
 * @param command - the complete bash input.
 * @returns true when the command's effect can change without the string
 *   changing.
 */
export function isMutableFileDependent(command: string): boolean {
  if (ENGINE.test(command)) return true
  return /(?:^|[\s;&|"'=])(?:\.{0,2}\/)?[\w.@+/-]+\.(?:sh|bash)\b/u.test(command)
}
