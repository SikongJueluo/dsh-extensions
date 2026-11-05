/**
 * Pure remote-exec protocol: the fixed remote-host script, the ssh argv, the
 * control-line parser and outcome classification. No DSH imports live here,
 * so every piece stays trivially unit-testable (see smoke.mjs).
 *
 * One call is three phases, separated by file descriptors rather than by
 * grepping log text:
 *
 * 1. Host prep (docker present → container exists → running/started) runs in
 *    the remote bash; failures emit a nonce-framed control line on stderr.
 * 2. Container setup runs in a login fish whose stdout/stderr are redirected
 *    to a container-side env log; `cd <cwd>` and the direnv bootstrap happen
 *    there, so their noise never reaches the command's streams.
 * 3. The command runs in that same fish process with fd 3/4 (the real ssh
 *    stdout/stderr) and writes its exit status to a status file; the host
 *    reads that file after the command and emits one final control line.
 *
 * The nonce is generated per call and frames the host's control line; normal
 * command output does not collide with it, and the host emits the line last so
 * it survives the bounded collected tail. The command still runs as arbitrary
 * container code, so this is a reporting protocol, not a security boundary.
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
  /** Default container directory for calls that omit `cwd` (absolute path). */
  readonly defaultCwd: string
  /**
   * Container shell, inserted inside a double-quoted assignment so `$(…)`
   * stays live; invoked as `<shell> -l -c <wrapper>`.
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

/** Distinctive exit code for host prep failures (docker/host side). */
export const PREP_EXIT_CODE = 86

/** Exit code the container wrapper uses when environment initialization fails. */
export const ENV_EXIT_CODE = 87

/** Exit code the container wrapper uses when the requested cwd is inaccessible. */
export const CWD_EXIT_CODE = 88

/** ssh's own failure exit code (openssh uses 255 for connection-level errors). */
export const SSH_EXIT_CODE = 255

/** How one remote_exec call ended. */
export type RemoteOutcome =
  | 'ok'
  | 'prep-error'
  | 'cwd-error'
  | 'env-error'
  | 'status-unknown'
  | 'ssh-error'
  | 'spawn-error'
  | 'timeout-unknown'
  | 'cancelled-unknown'

/** Every outcome, as a readonly tuple for schemas and tests. */
export const REMOTE_OUTCOMES = [
  'ok',
  'prep-error',
  'cwd-error',
  'env-error',
  'status-unknown',
  'ssh-error',
  'spawn-error',
  'timeout-unknown',
  'cancelled-unknown',
] as const

/** Kinds of nonce-framed control line the host appends to stderr. */
export type RemoteControlKind = 'prep-error' | 'cwd-error' | 'env-error' | 'status-unknown' | 'command-start'

/** Every control kind, as a readonly tuple for parsing and tests. */
export const REMOTE_CONTROL_KINDS = ['prep-error', 'cwd-error', 'env-error', 'status-unknown', 'command-start'] as const

/** One parsed final control line plus the stderr content before it. */
export interface RemoteControl {
  readonly kind: RemoteControlKind
  readonly detail: string
  /** stderr before the control line: command stderr, env log, or setup error. */
  readonly before: string
}

/** POSIX single-quoting for the remote bash layer (python shlex.quote's rules). */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Inputs to {@link buildRemoteScript} beyond the target itself. */
export interface RemoteScriptOptions {
  /** fish-syntax command from the model; evaluated inside the container shell. */
  readonly command: string
  /** Absolute container directory for this call (already validated). */
  readonly cwd: string
  /** Per-call token framing the final control line and the temp file names. */
  readonly nonce: string
  /** autoStart poll budget in 1-second attempts (clamped to at least 1). */
  readonly startAttempts: number
}

/**
 * Container-side fish wrapper, invoked as `fish -l -c <wrapper> <command>
 * <cwd> <status> <envInit>`. Its stdout/stderr are the env log (set up by the
 * outer sh), while fd 3/4 are the real ssh streams.
 */
const FISH_WRAPPER = `set -l __re_command $argv[1]
set -l __re_cwd $argv[2]
set -l __re_status $argv[3]
set -l __re_envinit $argv[4]
set -l __re_envlog "$__re_status.env"
set -l __re_export "$__re_status.export"
rm -f $__re_status $__re_export
if not cd -- $__re_cwd
    printf 'cwd-error\\n' > $__re_status
    exit ${CWD_EXIT_CODE}
end
fish_add_path -g $HOME/.nix-profile/bin
if test "$__re_envinit" = direnv
    if test -f .envrc
        direnv allow . >>$__re_envlog 2>&1
        if test $status -ne 0
            printf 'env-error\\n' > $__re_status
            exit ${ENV_EXIT_CODE}
        end
        direnv export fish >$__re_export 2>>$__re_envlog
        if test $status -ne 0
            printf 'env-error\\n' > $__re_status
            exit ${ENV_EXIT_CODE}
        end
        set -l __re_exported (cat $__re_export)
        if test $status -ne 0
            printf 'env-error\\n' > $__re_status
            exit ${ENV_EXIT_CODE}
        end
        eval $__re_exported
        if test $status -ne 0
            printf 'env-error\\n' > $__re_status
            exit ${ENV_EXIT_CODE}
        end
        rm -f $__re_export
    end
end
if not printf 'command-start\\n' > $__re_status
    exit 89
end
begin
    eval $__re_command
end >&3 2>&4
`

/**
 * Outer sh wrapper: save the real ssh streams on fd 3/4, point the login
 * fish's streams at the container-side env log, then exec the fish wrapper.
 * Invoked as `sh -c <outer> remote-exec <envlog> <shell> <wrapper> <command>
 * <cwd> <status> <envInit>`.
 */
const OUTER_SH = `exec 3>&1 4>&2 1>"$1" 2>&1
exec "$2" -l -c "$3" "$4" "$5" "$6" "$7"`

/** Build the stdin script for `ssh <target> bash -s --`. */
export function buildRemoteScript(target: RemoteTarget, options: RemoteScriptOptions): string {
  const container = shQuote(target.container)
  const attempts = Math.max(1, Math.floor(options.startAttempts))
  const nonce = options.nonce
  const status = `/tmp/remote-exec-${nonce}.status`
  const cwd = shQuote(options.cwd)
  const command = shQuote(options.command)
  const envInit = shQuote(target.envInit)
  const outer = shQuote(OUTER_SH)
  const wrapper = shQuote(FISH_WRAPPER)
  const notRunningBlock = target.autoStart
    ? [
        `  if ! docker start ${container} >/dev/null 2>&1; then`,
        `    control prep-error ${shQuote(`docker start failed for container: ${target.container}`)}`,
        `    exit ${PREP_EXIT_CODE}`,
        '  fi',
        '  i=0',
        `  while [ "$(docker inspect -f '{{.State.Running}}' ${container})" != 'true' ]; do`,
        '    i=$((i + 1))',
        `    if [ "$i" -ge ${attempts} ]; then`,
        `      control prep-error ${shQuote(`container still not running after ${attempts}s: ${target.container}`)}`,
        `      exit ${PREP_EXIT_CODE}`,
        '    fi',
        '    sleep 1',
        '  done',
      ].join('\n')
    : [
        `  control prep-error ${shQuote(`container is not running and autoStart is disabled: ${target.container}`)}`,
        `  exit ${PREP_EXIT_CODE}`,
      ].join('\n')
  return `set -Eeuo pipefail

control() {
  printf '\\nremote-exec:%s:%s:%s\\n' '${nonce}' "$1" "\${2:-}" >&2
}
status='${status}'
envlog="\${status}.env"

if ! command -v docker >/dev/null 2>&1; then
  control prep-error 'docker not found on remote host'
  exit ${PREP_EXIT_CODE}
fi

if ! docker inspect ${container} >/dev/null 2>&1; then
  control prep-error ${shQuote(`docker container not found: ${target.container}`)}
  exit ${PREP_EXIT_CODE}
fi

if [ "$(docker inspect -f '{{.State.Running}}' ${container})" != 'true' ]; then
${notRunningBlock}
fi

shell_path="${target.shell}"
user="${target.containerUser ?? DEFAULT_CONTAINER_USER}"
outer=${outer}
wrapper=${wrapper}
set +e
docker exec -i -u "$user" -w / ${container} /bin/sh -c "$outer" remote-exec "$envlog" "$shell_path" "$wrapper" ${command} ${cwd} "$status" ${envInit} </dev/null
rc=$?
set -e
status_text=''
status_err=''
status_read_failed=0
status_err_file="\${status}.err"
if status_text=$(docker exec -u "$user" ${container} cat "$status" 2>"$status_err_file"); then :; else
  status_text=''
  status_read_failed=1
  if [ -f "$status_err_file" ]; then status_err=$(cat "$status_err_file" 2>/dev/null || true); fi
fi
rm -f "$status_err_file" 2>/dev/null || true
case "$status_text" in
  command-start*)
    control command-start "$rc"
    ;;
  cwd-error*)
    docker exec -u "$user" ${container} cat "$envlog" >&2 2>/dev/null || true
    control cwd-error 'cwd is not accessible'
    ;;
  env-error*)
    docker exec -u "$user" ${container} cat "$envlog" >&2 2>/dev/null || true
    control env-error 'environment initialization failed'
    ;;
  *)
    if [ "$status_read_failed" = 1 ] && [ -n "$status_err" ]; then
      printf 'remote-exec: status read failed: %s\\n' "$status_err" >&2
    fi
    docker exec -u "$user" ${container} cat "$envlog" >&2 2>/dev/null || true
    if [ "$status_read_failed" = 1 ]; then
      control status-unknown 'status read failed'
    else
      control status-unknown 'status file missing or empty'
    fi
    ;;
esac
docker exec -u "$user" ${container} rm -f "$status" "$envlog" "$envlog.export" "$status_err_file" >/dev/null 2>&1 || true
exit "$rc"
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
 * Parse the final nonce-framed control line from stderr. The host emits it as
 * the last line, so the parser looks from the end; `before` is the content
 * that preceded it (command stderr, env log, or setup error). Normal command
 * output does not collide with the per-call nonce; a fake earlier line is
 * ignored because the host's line is last.
 */
export function parseControl(stderr: string, nonce: string): RemoteControl | undefined {
  const marker = `remote-exec:${nonce}:`
  const at = stderr.lastIndexOf(`\n${marker}`)
  const start = at < 0 ? (stderr.startsWith(marker) ? 0 : -1) : at + 1
  if (start < 0) return undefined
  const lineEnd = stderr.indexOf('\n', start)
  const line = stderr.slice(start, lineEnd < 0 ? undefined : lineEnd)
  const rest = line.slice(marker.length)
  const colon = rest.indexOf(':')
  const kind = colon < 0 ? rest : rest.slice(0, colon)
  if (!isControlKind(kind)) return undefined
  const detail = colon < 0 ? '' : rest.slice(colon + 1)
  const beforeEnd = at < 0 ? 0 : at
  return { kind, detail, before: stderr.slice(0, beforeEnd) }
}

function isControlKind(value: string): value is RemoteControlKind {
  return (REMOTE_CONTROL_KINDS as readonly string[]).includes(value)
}

/**
 * Classify one finished (or aborted) run. Timeout and caller cancellation
 * win over any control line: the local ssh was killed, so the remote
 * command's fate is unknown by construction. A `command-start` line is
 * authoritative for "the command ran" (the host wrote it after reading the
 * container status), including a command that itself exits 255. A
 * `status-unknown` line means the command may have run but the host could not
 * read its completion status; a missing control line is treated the same way
 * rather than claiming the command never started.
 */
export function classifyOutcome(
  exitCode: number | null,
  control: RemoteControl | undefined,
  timedOut: boolean,
  cancelled: boolean,
): RemoteOutcome {
  if (timedOut) return 'timeout-unknown'
  if (cancelled) return 'cancelled-unknown'
  switch (control?.kind) {
    case 'cwd-error':
      return 'cwd-error'
    case 'env-error':
      return 'env-error'
    case 'status-unknown':
      return 'status-unknown'
    case 'prep-error':
      return 'prep-error'
    case 'command-start':
      return 'ok'
  }
  if (exitCode === null || exitCode === SSH_EXIT_CODE) return 'ssh-error'
  return 'status-unknown'
}
