/**
 * Pure remote-exec protocol: the fixed remote-host script, the ssh argv, the control-line parser and outcome classification. No DSH imports live here, so every piece stays trivially unit-testable (see smoke.mjs).
 * @module dsh-remote-exec/exec
 */

/** A whitelisted target, resolved from the plugin-row config (operator-owned). */
export interface RemoteTarget {
  readonly sshHost: string
  readonly sshPort?: number
  readonly sshOptions?: readonly string[]
  readonly container: string
  readonly containerUser?: string
  readonly defaultCwd: string
  readonly shell: string
  readonly envInit: 'direnv' | 'none'
  readonly autoStart: boolean
  readonly description?: string
}

export const DEFAULT_CONTAINER_SHELL = '/home/$(id -un)/.nix-profile/bin/fish'

export const DEFAULT_CONTAINER_USER = '$(id -u):$(id -g)'

export const PREP_EXIT_CODE = 86

export const ENV_EXIT_CODE = 87

export const CWD_EXIT_CODE = 88

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
export type RemoteControlKind =
  | 'prep-error'
  | 'cwd-error'
  | 'env-error'
  | 'status-unknown'
  | 'command-start'

export const REMOTE_CONTROL_KINDS = [
  'prep-error',
  'cwd-error',
  'env-error',
  'status-unknown',
  'command-start',
] as const

/** One parsed final control line plus the stderr content before it. */
export interface RemoteControl {
  readonly kind: RemoteControlKind
  readonly detail: string
  readonly before: string
}

/** POSIX single-quoting for the remote bash layer (python shlex.quote's rules). */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Inputs to {@link buildRemoteScript} beyond the target itself. */
export interface RemoteScriptOptions {
  readonly command: string
  readonly cwd: string
  readonly nonce: string
  readonly startAttempts: number
}

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
docker exec -u "$user" ${container} rm -f "$status" "$envlog" "\${status}.export" "$status_err_file" >/dev/null 2>&1 || true
exit "$rc"
`
}

/** Build the local ssh argv for a target (resolved sshPath + fixed options). */
export function buildSshArgv(sshPath: string, target: RemoteTarget): string[] {
  const argv: string[] = [sshPath]
  if (target.sshPort !== undefined) argv.push('-p', String(target.sshPort))
  argv.push(
    '-o',
    'BatchMode=yes',
    ...(target.sshOptions ?? []),
    '-o',
    'StrictHostKeyChecking=accept-new',
    target.sshHost,
    'bash',
    '-s',
    '--',
  )
  return argv
}

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
  const beforeEnd = Math.max(at, 0)
  return { kind, detail, before: stderr.slice(0, beforeEnd) }
}

function isControlKind(value: string): value is RemoteControlKind {
  return (REMOTE_CONTROL_KINDS as readonly string[]).includes(value)
}

export function classifyOutcome(
  exitCode: number | null,
  control: RemoteControl | undefined,
  timedOut: boolean,
  cancelled: boolean,
): RemoteOutcome {
  if (timedOut) return 'timeout-unknown'
  if (cancelled) return 'cancelled-unknown'
  switch (control?.kind) {
    case undefined:
      break
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
