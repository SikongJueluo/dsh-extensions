/**
 * Pure remote-exec protocol: the fixed remote-host script, the ssh argv, and
 * outcome classification. No DSH imports live here, so every piece stays
 * trivially unit-testable (see smoke.mjs).
 *
 * The protocol mirrors Mini-Nav's `mini_nav/utils/remote.py`
 * (`build_remote_script` / `build_ssh_command`): one
 * `ssh <target> bash -s --` invocation with the script fed on stdin. The
 * remote login bash runs a fixed prep sequence — docker present → container
 * exists → container running (`docker start` + poll when `autoStart`) — and
 * then `exec docker exec -i -u <user> -w <workdir> <container> <shell>
 * -l -c '<fish_add_path; direnv; command>'`. The model's command only ever
 * reaches the innermost fish `-c` string; every operator parameter is
 * single-quoted for the remote bash layer, and prep failures are terminal:
 * there is no host-shell fallback anywhere.
 *
 * @module dsh-remote-exec/exec
 */

/** A whitelisted target, resolved from the plugin-row config (operator-owned). */
export interface RemoteTarget {
  /** `~/.ssh/config` alias (or user@host); never model-controlled. */
  readonly sshHost: string
  /** Remote ssh port; omitted lets ssh config decide. */
  readonly sshPort?: number
  /** Operator-trusted extra ssh options, pre-split (`['-o', 'Foo=bar']`). */
  readonly sshOptions?: readonly string[]
  /** Container name on the remote docker host. */
  readonly container: string
  /**
   * `docker exec -u` spec, inserted inside double quotes so command
   * substitution stays live; the default resolves the remote login user's
   * uid:gid (`$(id -u):$(id -g)`), exactly like remote.py.
   */
  readonly containerUser?: string
  /** `-w` workdir inside the container. */
  readonly workdir: string
  /**
   * Container shell, inserted verbatim into the script (no quoting — it may
   * embed `$(id -un)`), invoked as `<shell> -l -c <inner>`.
   */
  readonly shell: string
  /** `direnv` mirrors remote.py's env bootstrap; `none` runs the bare command. */
  readonly envInit: 'direnv' | 'none'
  /** `docker start` a stopped container (never create/rebuild). */
  readonly autoStart: boolean
  /** Human hint surfaced in approval prompts. */
  readonly description?: string
}

/** Default container shell: a login fish from the remote user's nix profile. */
export const DEFAULT_CONTAINER_SHELL = '/home/$(id -un)/.nix-profile/bin/fish'

/** Default `docker exec -u` spec: the remote login user's uid:gid. */
export const DEFAULT_CONTAINER_USER = '$(id -u):$(id -g)'

/** Distinctive exit code for prep-phase failures (remote docker/host side). */
export const PREP_EXIT_CODE = 86

/** Marker every prep-phase error line starts with; disambiguates exit codes. */
export const PREP_MARKER = 'remote-exec: error:'

/** ssh's own failure exit code (openssh uses 255 for connection-level errors). */
export const SSH_EXIT_CODE = 255

/** How one remote_exec call ended. */
export type RemoteOutcome =
  | 'ok'
  | 'prep-error'
  | 'ssh-error'
  | 'spawn-error'
  | 'timeout-unknown'
  | 'cancelled-unknown'

/** Every outcome, as a readonly tuple for schemas and tests. */
export const REMOTE_OUTCOMES = [
  'ok',
  'prep-error',
  'ssh-error',
  'spawn-error',
  'timeout-unknown',
  'cancelled-unknown',
] as const

/** POSIX single-quoting for the remote bash layer (python shlex.quote's rules). */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Inputs to {@link buildRemoteScript} beyond the target itself. */
export interface RemoteScriptOptions {
  /** fish-syntax command from the model; only ever enters the inner `fish -c`. */
  readonly command: string
  /** autoStart poll budget in 1-second attempts (clamped to at least 1). */
  readonly startAttempts: number
}

/** Build the stdin script for `ssh <target> bash -s --` (remote.py's shape). */
export function buildRemoteScript(target: RemoteTarget, options: RemoteScriptOptions): string {
  const container = shQuote(target.container)
  const workdir = shQuote(target.workdir)
  const user = target.containerUser ?? DEFAULT_CONTAINER_USER
  const attempts = Math.max(1, Math.floor(options.startAttempts))
  // remote.py's inner fish bootstrap: guarantee the nix profile bin dir, then
  // (opt-in) direnv-export the project devenv. Fish syntax throughout —
  // callers must pass fish-compatible commands (`env VAR=1 cmd`, not `VAR=1 cmd`).
  const direnvInit =
    target.envInit === 'direnv'
      ? 'if test -f .envrc; direnv allow . >/dev/null 2>&1; or true; eval (direnv export fish); end; '
      : ''
  const inner = `fish_add_path -g $HOME/.nix-profile/bin; ${direnvInit}${options.command}`
  const notRunningBlock = target.autoStart
    ? [
        `    echo 'remote-exec: starting stopped container: ${target.container}' >&2`,
        '    if ! docker start ' + container + ' >/dev/null 2>&1; then',
        `      echo '${PREP_MARKER} docker start failed for container: ${target.container}' >&2`,
        `      exit ${PREP_EXIT_CODE}`,
        '    fi',
        '    i=0',
        `    while [ "$(docker inspect -f '{{.State.Running}}' ${container})" != 'true' ]; do`,
        '      i=$((i + 1))',
        `      if [ "$i" -ge ${attempts} ]; then`,
        `        echo '${PREP_MARKER} container still not running after ${attempts}s: ${target.container}' >&2`,
        `        exit ${PREP_EXIT_CODE}`,
        '      fi',
        '      sleep 1',
        '    done',
      ].join('\n')
    : [
        `    echo '${PREP_MARKER} container is not running and autoStart is disabled: ${target.container}' >&2`,
        `    exit ${PREP_EXIT_CODE}`,
      ].join('\n')
  return `set -Eeuo pipefail

# Fixed remote-exec prep sequence: docker present -> container exists ->
# running (an existing container is started and polled when autoStart).
# Prep failures exit ${PREP_EXIT_CODE} with a '${PREP_MARKER}' line and NEVER
# fall back to the remote login shell — failure before docker exec is terminal.

if ! command -v docker >/dev/null 2>&1; then
  echo '${PREP_MARKER} docker not found on remote host' >&2
  exit ${PREP_EXIT_CODE}
fi

if ! docker inspect ${container} >/dev/null 2>&1; then
  echo '${PREP_MARKER} docker container not found: ${target.container}' >&2
  exit ${PREP_EXIT_CODE}
fi

if [ "$(docker inspect -f '{{.State.Running}}' ${container})" != 'true' ]; then
${notRunningBlock}
fi

exec docker exec -i \\
  -u "${user}" \\
  -w ${workdir} \\
  ${container} \\
  ${target.shell} \\
  -l -c ${shQuote(inner)}
`
}

/** Build the local ssh argv for a target (resolved sshPath + fixed options). */
export function buildSshArgv(sshPath: string, target: RemoteTarget): string[] {
  const argv: string[] = [sshPath]
  if (target.sshPort !== undefined) argv.push('-p', String(target.sshPort))
  // BatchMode is an invariant — the tool never answers interactive prompts —
  // and comes FIRST because ssh keeps the first obtained value per option.
  argv.push('-o', 'BatchMode=yes')
  argv.push(...(target.sshOptions ?? []))
  // TOFU default for host keys; an operator option above may tighten ('yes')
  // or widen ('no') it, but a *changed* host key always fails.
  argv.push('-o', 'StrictHostKeyChecking=accept-new')
  argv.push(target.sshHost, 'bash', '-s', '--')
  return argv
}

/**
 * Classify one finished (or aborted) run. Timeout and caller cancellation
 * win over any exit code: the local ssh was killed, so the remote command's
 * fate is unknown by construction.
 */
export function classifyOutcome(
  exitCode: number | null,
  stderr: string,
  timedOut: boolean,
  cancelled: boolean,
): RemoteOutcome {
  if (timedOut) return 'timeout-unknown'
  if (cancelled) return 'cancelled-unknown'
  if (stderr.includes(PREP_MARKER)) return 'prep-error'
  if (exitCode === null || exitCode === SSH_EXIT_CODE) return 'ssh-error'
  return 'ok'
}
