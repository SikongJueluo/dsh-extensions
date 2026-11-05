/* Runtime smoke test for dsh-remote-exec.
 *
 * Part 1 — plugin surface: config defaults, target-dict defaults.
 * Part 2 — target resolution: required defaultCwd, invalid paths rejected.
 * Part 3 — exec.ts protocol: shQuote, buildRemoteScript (cwd/command argv,
 *          nonce control lines, env-log separation, autoStart on/off,
 *          prep markers/exits), buildSshArgv ordering, control parsing,
 *          classifyOutcome truth table.
 * Part 4 — display.ts: ANSI/CR/repeat cleanup and hard-bounded excerpts.
 * Part 5 — GrantStore session memory + eviction.
 * Part 6 — RemoteRunner against a stub ctx.subprocess + stub spillStore:
 *          outcome/exit-code classification, bounded display, full-output
 *          spill retrieval, lossy-tail handling, timeout/spawn errors.
 * Part 7 — tool registration surface (target enum, cwd parameter, output).
 *
 * The real ssh/docker path is deliberately not exercised here (no target is
 * reachable from CI, and host-side ssh needs the operator's ~/.ssh); see the
 * package README for the live verification recipe.
 */
import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import {
  Config,
  CWD_EXIT_CODE,
  DEFAULT_CONTAINER_SHELL,
  ENV_EXIT_CODE,
  GrantStore,
  PREP_EXIT_CODE,
  REMOTE_CONTROL_KINDS,
  REMOTE_OUTCOMES,
  RemoteRunner,
  SSH_EXIT_CODE,
  apply,
  buildRemoteScript,
  buildSshArgv,
  classifyOutcome,
  formatDisplay,
  formatResult,
  parseControl,
  resolveTargets,
  shQuote,
} from './lib/index.js'

let failures = 0
function check(label, condition) {
  if (condition) {
    console.log(`ok - ${label}`)
  } else {
    failures += 1
    console.error(`FAIL - ${label}`)
  }
}
function throws(label, fn) {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  check(label, threw)
}

// ── Part 1: plugin surface ────────────────────────────────────────────────
const defaults = Config({})
check('default sshPath', defaults.sshPath === 'ssh')
check('default approvalMode', defaults.approvalMode === 'session')
check('default timeoutMs', defaults.defaultTimeoutMs === 600000)
check('default maxTimeoutMs', defaults.maxTimeoutMs === 3600000)
check('default startTimeoutMs', defaults.startTimeoutMs === 60000)
check('default graceMs', defaults.graceMs === 5000)
check('default stdout/stderr raw budgets', defaults.stdoutMaxBytes === 1048576 && defaults.stderrMaxBytes === 65536)
check('default display budget', defaults.displayMaxBytes === 16384)
check('default targets is an empty dict', Array.isArray(Object.keys(defaults.targets)) && Object.keys(defaults.targets).length === 0)

const withTarget = Config({ targets: { box: { sshHost: 'gpu', container: 'nav', defaultCwd: '/w' } } })
const box = withTarget.targets.box
check(
  'target defaults filled by the dict schema',
  box.shell === DEFAULT_CONTAINER_SHELL && box.autoStart === true && box.envInit === 'direnv' && box.containerUser === undefined,
)
check('target required fields survive', box.sshHost === 'gpu' && box.container === 'nav' && box.defaultCwd === '/w')
throws('target without defaultCwd rejected by the schema', () => Config({ targets: { box: { sshHost: 'gpu', container: 'nav' } } }))
throws('legacy workdir cannot replace defaultCwd', () => Config({ targets: { box: { sshHost: 'gpu', container: 'nav', workdir: '/w' } } }))

// ── Part 2: target resolution: required defaultCwd ───────────────────────
{
  const cfg = Config({ targets: { modern: { sshHost: 'h', container: 'c', defaultCwd: '/modern' } } })
  const resolved = resolveTargets(cfg.targets)
  check('modern defaultCwd survives', resolved.get('modern').defaultCwd === '/modern')
  check('resolved target no longer carries workdir', !('workdir' in resolved.get('modern')))
  check(
    'resolved target keeps shell/envInit/autoStart',
    resolved.get('modern').shell === DEFAULT_CONTAINER_SHELL && resolved.get('modern').envInit === 'direnv' && resolved.get('modern').autoStart === true,
  )
}
throws('missing defaultCwd rejected by resolution', () =>
  resolveTargets({ bad: { sshHost: 'h', container: 'c', shell: DEFAULT_CONTAINER_SHELL, envInit: 'direnv', autoStart: true } }),
)
throws('relative defaultCwd rejected', () => resolveTargets(Config({ targets: { bad: { sshHost: 'h', container: 'c', defaultCwd: 'rel' } } }).targets))
throws('NUL defaultCwd rejected', () => resolveTargets(Config({ targets: { bad: { sshHost: 'h', container: 'c', defaultCwd: '/w\u0000x' } } }).targets))

// ── Part 3: protocol ──────────────────────────────────────────────────────
check('shQuote plain', shQuote('plain') === "'plain'")
check('shQuote with single quote', shQuote("a'b") === "'a'\\''b'")
check('shQuote empty', shQuote('') === "''")

const nonce = '0123456789abcdef0123456789abcdef'
const target = {
  sshHost: 'gpu-workstation',
  container: 'mini-nav',
  defaultCwd: '/workspace/Mini-Nav',
  shell: DEFAULT_CONTAINER_SHELL,
  envInit: 'direnv',
  autoStart: true,
}
const cwd = '/workspace/Mini-Nav/sub'
const command = 'just train'
const script = buildRemoteScript(target, { command, cwd, nonce, startAttempts: 30 })
check('script pins bash safety net', script.startsWith('set -Eeuo pipefail'))
check('script defines the nonce control function', script.includes('control()') && script.includes(`'${nonce}'`))
check('script docker-execs the named container', script.includes('docker exec -i') && script.includes("'mini-nav'"))
check('script starts the wrapper at / and lets it cd', script.includes('-w /') && script.includes('cd -- $__re_cwd'))
check('script passes cwd as one quoted argv', script.includes(shQuote(cwd)))
check('script passes command as one quoted argv', script.includes(shQuote(command)))
check('script does not embed the command in the wrapper', script.includes('eval $__re_command') && !script.includes(`eval ${command}`))
check('script derives status/envlog paths from the nonce', script.includes(`status='/tmp/remote-exec-${nonce}.status'`) && script.includes('envlog="${status}.env"'))
check('script redirects login-fish noise to the env log', script.includes('exec 3>&1 4>&2 1>"$1" 2>&1'))
check(
  'wrapper keeps env init before the command',
  script.includes('direnv export fish') && script.indexOf('command-start') > script.indexOf('direnv export fish'),
)
check('wrapper runs the command on fd 3/4', script.includes('begin') && script.includes('end >&3 2>&4'))
check('script passes the envInit mode', script.includes("'direnv'"))
check(
  'script classifies statuses with control lines',
  ['command-start*', 'cwd-error*', 'env-error*', 'status-unknown'].every((token) => script.includes(token)),
)
check('script gives the command EOF stdin, not the remote script', script.includes('</dev/null'))
check('script captures the status read error', script.includes('status_err_file') && script.includes('status-unknown'))
check(
  'wrapper does not unlink the open env log',
  script.includes('rm -f $__re_status $__re_export') && !script.includes('rm -f $__re_status $__re_envlog'),
)
check('wrapper checks the export-file read before eval', script.includes('set -l __re_exported (cat $__re_export)'))
check('script reads the status as the container user', script.includes('docker exec -u "$user"') && script.includes('cat "$status"'))
check(
  'script cleans status, env log, direnv export and read-error files',
  script.includes('rm -f "$status" "$envlog" "${status}.export" "$status_err_file"'),
)
check('script does not misname the direnv export in cleanup', !script.includes('"$envlog.export"'))
check('prep errors use the marker + distinct exit', script.includes('control prep-error') && script.includes(`exit ${PREP_EXIT_CODE}`))
check('autoStart branch starts and polls', script.includes('docker start') && script.includes('-ge 30'))

const noStart = buildRemoteScript({ ...target, autoStart: false }, { command: 'ls', cwd: '/w', nonce, startAttempts: 5 })
check('autoStart disabled is a terminal prep error', noStart.includes('autoStart is disabled') && !noStart.includes('docker start'))

const noDirenv = buildRemoteScript({ ...target, envInit: 'none' }, { command: 'ls', cwd: '/w', nonce, startAttempts: 5 })
check('envInit none is passed to the wrapper', noDirenv.includes("'none'") && noDirenv.includes('direnv export fish'))

const hostileCwd = `/w'; rm -rf /; '`
const hostileCommand = `echo '; rm -rf /; '`
const hostile = buildRemoteScript({ ...target, envInit: 'none' }, { command: hostileCommand, cwd: hostileCwd, nonce, startAttempts: 5 })
check('hostile cwd is neutralized as an argv', hostile.includes(shQuote(hostileCwd)))
check('hostile command is neutralized as an argv', hostile.includes(shQuote(hostileCommand)))

const argv = buildSshArgv('/usr/bin/ssh', { ...target, sshPort: 2222, sshOptions: ['-o', 'ProxyJump=bastion'] })
check(
  'ssh argv: port, locked BatchMode first, operator opts, default accept-new, then bash -s',
  JSON.stringify(argv) ===
    JSON.stringify([
      '/usr/bin/ssh',
      '-p',
      '2222',
      '-o',
      'BatchMode=yes',
      '-o',
      'ProxyJump=bastion',
      '-o',
      'StrictHostKeyChecking=accept-new',
      'gpu-workstation',
      'bash',
      '-s',
      '--',
    ]),
)
const argvNoPort = buildSshArgv('ssh', target)
check('no port → ssh config decides', !argvNoPort.includes('-p') && argvNoPort.at(-3) === 'bash')

{
  const line = (kind, detail = '') => `\nremote-exec:${nonce}:${kind}${detail === '' ? '' : `:${detail}`}\n`
  const commandStart = parseControl(line('command-start', '7'), nonce)
  check('parse command-start kind/detail', commandStart?.kind === 'command-start' && commandStart.detail === '7' && commandStart.before === '')
  const envError = parseControl(`build noise\nline2\n${line('env-error', 'direnv export failed')}`, nonce)
  check('parse env-error keeps the preceding env log', envError?.kind === 'env-error' && envError.before === 'build noise\nline2\n')
  const atStart = parseControl(`remote-exec:${nonce}:cwd-error:nope\n`, nonce)
  check('parse control line without a leading newline', atStart?.kind === 'cwd-error' && atStart.before === '')
  check('parse ignores a different nonce', parseControl(`\nremote-exec:${'f'.repeat(32)}:command-start:0\n`, nonce) === undefined)
  check('parse ignores an unknown kind', parseControl(line('not-a-kind'), nonce) === undefined)
  check('parse ignores stderr with no control line', parseControl('plain stderr\n', nonce) === undefined)
}

{
  const control = (kind, detail = '') => ({ kind, detail, before: '' })
  check('classify no control + exit 0 is status-unknown', classifyOutcome(0, undefined, false, false) === 'status-unknown')
  check('classify no control + exit 1 is status-unknown', classifyOutcome(1, undefined, false, false) === 'status-unknown')
  check('classify ssh-error 255', classifyOutcome(255, undefined, false, false) === 'ssh-error')
  check('classify signal death without flags is ssh-error', classifyOutcome(null, undefined, false, false) === 'ssh-error')
  check('classify command-start is ok', classifyOutcome(0, control('command-start', '0'), false, false) === 'ok')
  check(
    'classify command exit 255 is ok when command-start is present',
    classifyOutcome(255, control('command-start', '255'), false, false) === 'ok',
  )
  check('classify prep-error control', classifyOutcome(PREP_EXIT_CODE, control('prep-error'), false, false) === 'prep-error')
  check('classify status-unknown control', classifyOutcome(127, control('status-unknown'), false, false) === 'status-unknown')
  check('classify env-error control', classifyOutcome(ENV_EXIT_CODE, control('env-error'), false, false) === 'env-error')
  check('classify cwd-error control', classifyOutcome(CWD_EXIT_CODE, control('cwd-error'), false, false) === 'cwd-error')
  check('classify timeout wins over command-start', classifyOutcome(0, control('command-start'), true, false) === 'timeout-unknown')
  check('classify cancel wins over command-start', classifyOutcome(0, control('command-start'), false, true) === 'cancelled-unknown')
  check('classify timeout wins over cancel', classifyOutcome(0, control('command-start'), true, true) === 'timeout-unknown')
  check(
    'outcome enum includes the phase-1 outcomes',
    ['cwd-error', 'env-error', 'status-unknown', 'prep-error', 'ok'].every((o) => REMOTE_OUTCOMES.includes(o)),
  )
  check(
    'control kinds are the expected five',
    REMOTE_CONTROL_KINDS.length === 5 &&
      REMOTE_CONTROL_KINDS.includes('command-start') &&
      REMOTE_CONTROL_KINDS.includes('status-unknown') &&
      !REMOTE_CONTROL_KINDS.includes('start-error'),
  )
  check('ssh exit constant is 255', SSH_EXIT_CODE === 255)
}

// ── Part 4: display ──────────────────────────────────────────────────────
check('display strips ANSI', formatDisplay('\x1b[31mred\x1b[0m\n', 1024).text === 'red\n')
check('display collapses CR progress', formatDisplay('progress 1\rprogress 2\rprogress 3\n', 1024).text === 'progress 3\n')
check('display keeps CRLF content', formatDisplay('hello\r\nworld\r\n', 1024).text === 'hello\nworld\n')
check('display folds identical consecutive lines with a count', formatDisplay('a\na\na\nb\n', 1024).text === 'a [x3]\nb\n')
check(
  'display does not fold distinct metric lines',
  formatDisplay('step=1 loss=1\nstep=2 loss=2\n', 1024).text === 'step=1 loss=1\nstep=2 loss=2\n',
)
check('display leaves small empty input empty', formatDisplay('', 1024).text === '' && formatDisplay('', 1024).truncated === false)
{
  const big = formatDisplay('x'.repeat(5000), 1024)
  check('display truncates a huge single line', big.truncated === true && big.text.includes('bytes omitted'))
  check('display excerpt stays within the byte budget', Buffer.byteLength(big.text, 'utf8') <= 1024)
  const huge = formatDisplay('line\n'.repeat(2000), 1024)
  check('display truncates a multi-line stream within budget', huge.truncated === true && Buffer.byteLength(huge.text, 'utf8') <= 1024)
}

// ── Part 5: GrantStore ────────────────────────────────────────────────────
const grants = new GrantStore()
grants.add('s1', 'gpu')
check('grant visible in the same session', grants.has('s1', 'gpu'))
check('grant invisible in another session', !grants.has('s2', 'gpu'))
check('grant is per target', !grants.has('s1', 'other'))
grants.add('s1', 'other')
check('second target granted in same session', grants.has('s1', 'other'))
for (let i = 0; i < 400; i += 1) grants.add(`bulk-${i}`, 'gpu')
check('eviction drops the oldest sessions', !grants.has('bulk-0', 'gpu') && grants.has('bulk-399', 'gpu'))

// ── Part 6: RemoteRunner against stub subprocess/spillStore ──────────────
function controlLine(token, kind, detail = '') {
  return `\nremote-exec:${token}:${kind}${detail === '' ? '' : `:${detail}`}\n`
}
function nonceOf(script) {
  return /\/tmp\/remote-exec-([0-9a-f]{32})\.status/.exec(script)?.[1]
}
function stubSubprocess({
  exitCode = 0,
  stdout = '',
  stderr = '',
  control,
  stdoutLossy = false,
  stdoutTotalBytes,
  stdoutSpillPath,
  hang = false,
  resolveThrows = null,
  spillStore,
} = {}) {
  const spawns = []
  return {
    spawns,
    ctx: {
      get: (name) => (name === 'spillStore' ? spillStore : undefined),
      subprocess: {
        resolveExecutable: async () => {
          if (resolveThrows !== null) throw resolveThrows
          return '/usr/bin/ssh'
        },
        spawn: (spec) => {
          spawns.push(spec)
          const token = nonceOf(spec.stdio.stdin.data)
          const stderrText = control === undefined || token === undefined ? stderr : `${stderr}${controlLine(token, control.kind, control.detail)}`
          return {
            done: hang
              ? new Promise((resolve) => {
                  spec.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
                })
              : Promise.resolve({ exitCode }),
            collected: {
              stdout: {
                readFrom: () => ({
                  text: stdout,
                  nextOffset: stdoutTotalBytes ?? Buffer.byteLength(stdout),
                  lossy: stdoutLossy,
                  ...(stdoutSpillPath === undefined ? {} : { spillPath: stdoutSpillPath }),
                }),
              },
              stderr: {
                readFrom: () => ({
                  text: stderrText,
                  nextOffset: Buffer.byteLength(stderrText),
                  lossy: false,
                }),
              },
            },
          }
        },
      },
    },
  }
}
function stubSpillStore({ fail = null } = {}) {
  const saves = []
  return {
    saves,
    store: {
      saveText: async (input) => {
        if (fail !== null) throw fail
        saves.push(input)
        return {
          locator: `/tmp/spill-${saves.length}`,
          bytes: Buffer.byteLength(input.content),
          retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
        }
      },
    },
  }
}
const runTarget = {
  sshHost: 'gpu',
  container: 'nav',
  defaultCwd: '/w',
  shell: '/bin/fish',
  envInit: 'none',
  autoStart: false,
}
async function runStub(stub, { displayMaxBytes, cwd = '/w', timeoutMs = 5000 } = {}) {
  const cfg = Config(displayMaxBytes === undefined ? {} : { displayMaxBytes })
  return new RemoteRunner(stub.ctx, cfg).run('gpu', runTarget, 'echo ok', {
    cwd,
    timeoutMs,
    owner: { sessionId: 'session-1' },
    callId: 'call-1',
  })
}

{
  const stub = stubSubprocess({ stdout: 'ok\n', control: { kind: 'command-start', detail: '0' } })
  const result = await runStub(stub)
  const token = nonceOf(stub.spawns[0].stdio.stdin.data)
  check('runner feeds the script on stdin', stub.spawns[0].stdio.stdin.data.includes('docker exec') && stub.spawns[0].argv.at(-3) === 'bash')
  check('runner script carries the per-call cwd', stub.spawns[0].stdio.stdin.data.includes(shQuote('/w')))
  check('runner script carries the nonce control line', stub.spawns[0].stdio.stdin.data.includes(`'${token}'`))
  check('runner ok path classified', result.outcome === 'ok' && result.exitCode === 0 && result.stdout === 'ok\n')
  check('runner reports target and cwd', result.target === 'gpu' && result.cwd === '/w')
  check('runner reports byte totals', result.stdoutBytes === 3 && result.stderrBytes === 0)
  check('runner ok result is lossless JSON', snapshotJsonValue(result) !== undefined)
  check('runner small output is not truncated', result.stdoutTruncated === false && result.stderrTruncated === false)
}
{
  const stub = stubSubprocess({ stdout: 'ok\n', control: { kind: 'command-start', detail: '0' } })
  const result = await runStub(stub)
  check('runner strips the command-start control line', result.outcome === 'ok' && result.exitCode === 0 && result.stderr === '')
}
{
  const stub = stubSubprocess({ exitCode: 1, control: { kind: 'command-start', detail: '1' } })
  const result = await runStub(stub)
  check('runner reports a non-zero command exit as ok', result.outcome === 'ok' && result.exitCode === 1)
}
{
  const stub = stubSubprocess({ exitCode: 255, control: { kind: 'command-start', detail: '255' } })
  const result = await runStub(stub)
  check('runner treats command exit 255 as ok when command-start is present', result.outcome === 'ok' && result.exitCode === 255)
}
{
  const stub = stubSubprocess({
    exitCode: 87,
    stderr: 'env build failed\n',
    control: { kind: 'env-error', detail: 'environment initialization failed' },
  })
  const result = await runStub(stub)
  check(
    'runner classifies env-error',
    result.outcome === 'env-error' && result.stderr === 'env build failed\n' && result.detail === 'environment initialization failed',
  )
  check('runner omits exitCode for env-error', !('exitCode' in result))
  check('runner env-error byte total excludes the control line', result.stderrBytes === Buffer.byteLength('env build failed\n'))
  check('runner env-error result is lossless JSON', snapshotJsonValue(result) !== undefined)
}
{
  const stub = stubSubprocess({
    exitCode: 88,
    stderr: 'cd: no such dir\n',
    control: { kind: 'cwd-error', detail: 'cwd is not accessible' },
  })
  const result = await runStub(stub)
  check(
    'runner classifies cwd-error',
    result.outcome === 'cwd-error' && result.stderr === 'cd: no such dir\n' && result.detail === 'cwd is not accessible',
  )
}
{
  const stub = stubSubprocess({
    exitCode: 86,
    control: { kind: 'prep-error', detail: 'docker not found on remote host' },
  })
  const result = await runStub(stub)
  check(
    'runner classifies prep-error',
    result.outcome === 'prep-error' && result.stderr === '' && result.detail === 'docker not found on remote host',
  )
  check('runner prep-error has no exitCode', !('exitCode' in result) && result.stderrBytes === 0)
}
{
  const stub = stubSubprocess({
    exitCode: 127,
    stderr: 'OCI runtime exec failed\n',
    control: { kind: 'status-unknown', detail: 'status read failed: container is not running' },
  })
  const result = await runStub(stub)
  check(
    'runner maps status-unknown without claiming the command did not start',
    result.outcome === 'status-unknown' &&
      result.stderr === 'OCI runtime exec failed\n' &&
      result.detail.includes('status read failed'),
  )
  const rendered = formatResult(result)
  check(
    'formatResult status-unknown warns it may have run',
    rendered.includes('may have run') && !rendered.includes('NOT started'),
  )
  check('runner status-unknown result is lossless JSON', snapshotJsonValue(result) !== undefined)
}
{
  const stub = stubSubprocess({ exitCode: 255, stderr: 'ssh: connect failed\n' })
  const result = await runStub(stub)
  check(
    'runner classifies ssh-error',
    result.outcome === 'ssh-error' && result.stderr === 'ssh: connect failed\n' && !('exitCode' in result),
  )
  check('runner ssh-error result is lossless JSON', snapshotJsonValue(result) !== undefined)
}
{
  const stub = stubSubprocess({ hang: true })
  const result = await runStub(stub, { timeoutMs: 100 })
  check('runner timeout → timeout-unknown without exitCode', result.outcome === 'timeout-unknown' && !('exitCode' in result))
  check('runner timeout result is lossless JSON', snapshotJsonValue(result) !== undefined)
}
{
  const stub = stubSubprocess({ hang: true, control: { kind: 'command-start', detail: '0' } })
  const result = await runStub(stub, { timeoutMs: 100 })
  check(
    'runner timeout with a late control line stays unknown without exitCode',
    result.outcome === 'timeout-unknown' && !('exitCode' in result),
  )
}
{
  const stub = stubSubprocess({ resolveThrows: new Error('ssh not found') })
  const result = await runStub(stub)
  check(
    'runner spawn-error classified',
    result.outcome === 'spawn-error' && result.stderr === 'ssh not found' && result.cwd === '/w',
  )
  check('runner spawn-error result is lossless JSON', snapshotJsonValue(result) !== undefined)
}
{
  const spill = stubSpillStore()
  const stub = stubSubprocess({
    stdout: 'x'.repeat(5000),
    control: { kind: 'command-start', detail: '0' },
    spillStore: spill.store,
  })
  const result = await runStub(stub, { displayMaxBytes: 1024 })
  check('runner truncates the model-facing stdout', result.stdoutTruncated === true && Buffer.byteLength(result.stdout, 'utf8') <= 1024)
  check('runner reports the raw stdout total', result.stdoutBytes === 5000)
  check('runner saves the full raw stdout', spill.saves.length === 1 && spill.saves[0].content === 'x'.repeat(5000))
  check(
    'runner spill carries owner/source/call id',
    spill.saves[0].owner.sessionId === 'session-1' &&
      spill.saves[0].source.toolName === 'remote_exec' &&
      spill.saves[0].source.callId === 'call-1',
  )
  check('runner returns the spill locator/hint', result.stdoutSpill?.locator === '/tmp/spill-1' && result.stdoutSpill.hint.includes('read'))
  check('runner spill result is lossless JSON', snapshotJsonValue(result) !== undefined)
  const rendered = formatResult(result)
  check(
    'formatResult names the excerpt and full-output locator',
    rendered.includes('excerpt') && rendered.includes('full stdout: /tmp/spill-1'),
  )
}
{
  const spill = stubSpillStore()
  const stub = stubSubprocess({ stdout: 'ok\n', control: { kind: 'command-start', detail: '0' }, spillStore: spill.store })
  const result = await runStub(stub)
  check('runner does not spill a complete small stream', spill.saves.length === 0 && result.stdoutSpill === undefined)
}
{
  const spill = stubSpillStore()
  const stub = stubSubprocess({
    exitCode: 87,
    stderr: 'e'.repeat(5000),
    control: { kind: 'env-error', detail: 'environment initialization failed' },
    spillStore: spill.store,
  })
  const result = await runStub(stub, { displayMaxBytes: 1024 })
  check(
    'runner truncates the env log stderr',
    result.outcome === 'env-error' && result.stderrTruncated === true && Buffer.byteLength(result.stderr, 'utf8') <= 1024,
  )
  check('runner reports the env log total', result.stderrBytes === 5000)
  check(
    'runner saves the full env log',
    spill.saves.length === 1 &&
      spill.saves[0].content === 'e'.repeat(5000) &&
      spill.saves[0].suggestedName.endsWith('-stderr.log'),
  )
  check('runner returns the stderr spill locator', result.stderrSpill?.locator === '/tmp/spill-1')
}
{
  const spill = stubSpillStore({ fail: new Error('disk full') })
  const stub = stubSubprocess({
    stdout: 'x'.repeat(5000),
    control: { kind: 'command-start', detail: '0' },
    spillStore: spill.store,
  })
  const result = await runStub(stub, { displayMaxBytes: 1024 })
  check('runner degrades when the spill save fails', result.stdoutSpill === undefined && result.spillError.includes('disk full'))
  check(
    'runner still returns the bounded display on spill failure',
    result.stdoutTruncated === true && Buffer.byteLength(result.stdout, 'utf8') <= 1024,
  )
  check('runner spill-failure result is lossless JSON', snapshotJsonValue(result) !== undefined)
}
{
  const stub = stubSubprocess({
    stdout: 'x'.repeat(5000),
    control: { kind: 'command-start', detail: '0' },
  })
  const result = await runStub(stub, { displayMaxBytes: 1024 })
  check('runner reports an unavailable spill store', result.stdoutSpill === undefined && result.spillError.includes('not mounted'))
}
{
  const dir = await mkdtemp(join(tmpdir(), 'remote-exec-smoke-'))
  try {
    const complete = `head\n${'x'.repeat(5000)}\ntail\n`
    const path = join(dir, 'stdout.spill')
    await writeFile(path, complete)
    const spill = stubSpillStore()
    const stub = stubSubprocess({
      stdout: 'tail\n',
      stdoutLossy: true,
      stdoutTotalBytes: Buffer.byteLength(complete),
      stdoutSpillPath: path,
      control: { kind: 'command-start', detail: '0' },
      spillStore: spill.store,
    })
    const result = await runStub(stub, { displayMaxBytes: 1024 })
    check(
      'runner recovers the complete stream from the provider spill file',
      result.lossy === undefined && result.stdoutBytes === Buffer.byteLength(complete),
    )
    check('runner saves the recovered complete stream', spill.saves[0].content === complete)
    check('runner recovered-spill result is lossless JSON', snapshotJsonValue(result) !== undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
{
  const spill = stubSpillStore()
  const stub = stubSubprocess({
    stdout: 'tail\n',
    stdoutLossy: true,
    stdoutTotalBytes: 5000,
    control: { kind: 'command-start', detail: '0' },
    spillStore: spill.store,
  })
  const result = await runStub(stub, { displayMaxBytes: 1024 })
  check('runner marks an unrecoverable raw stream lossy', result.lossy === true && result.stdoutBytes === 5000)
  check(
    'runner saves the retained tail with a tail name',
    spill.saves.length === 1 && spill.saves[0].suggestedName.endsWith('-tail.log') && spill.saves[0].content === 'tail\n',
  )
  check('runner lossy result is lossless JSON', snapshotJsonValue(result) !== undefined)
  check('formatResult warns about the retained tail', formatResult(result).includes('only the retained tail is available'))
}
{
  const stub = stubSubprocess({
    exitCode: 87,
    stderr: 'env failed\n',
    control: { kind: 'env-error', detail: 'environment initialization failed' },
  })
  const result = await runStub(stub)
  const rendered = formatResult(result)
  check(
    'formatResult warns env init failed and the command did not start',
    rendered.includes('Environment initialization failed; the command was NOT started.'),
  )
  check('formatResult includes the protocol detail', rendered.includes('detail: environment initialization failed'))
}
{
  const stub = stubSubprocess({ hang: true })
  const result = await runStub(stub, { timeoutMs: 100 })
  check('formatResult warns the remote command may still be running', formatResult(result).includes('STILL BE RUNNING'))
}

// ── Part 7: tool registration surface ────────────────────────────────────
function fakeToolCtx() {
  const registered = []
  return {
    registered,
    ctx: {
      logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
      get: () => undefined,
      tools: { register: (definition) => (registered.push(definition), () => {}) },
      subprocess: {
        resolveExecutable: async () => '/usr/bin/ssh',
        spawn: () => {
          throw new Error('not used')
        },
      },
    },
  }
}
{
  const fake = fakeToolCtx()
  apply(
    fake.ctx,
    Config({
      targets: {
        gpu: { sshHost: 'h', container: 'c', defaultCwd: '/workspace/projects' },
        other: { sshHost: 'h2', container: 'c2', defaultCwd: '/w2' },
      },
    }),
  )
  const tool = fake.registered[0]
  check('apply registers exactly one remote_exec tool', fake.registered.length === 1 && tool.name === 'remote_exec')
  check(
    'target parameter is an enum of configured targets',
    Array.isArray(tool.parameters.properties.target.enum) &&
      tool.parameters.properties.target.enum.includes('gpu') &&
      tool.parameters.properties.target.enum.includes('other'),
  )
  check(
    'cwd parameter is optional, command required',
    !tool.parameters.required.includes('cwd') && tool.parameters.required.includes('command'),
  )
  check(
    'output schema carries cwd and byte/truncation fields',
    tool.output.schema.required.includes('cwd') &&
      tool.output.schema.required.includes('stdoutBytes') &&
      tool.output.schema.required.includes('stdoutTruncated'),
  )
  check(
    'output schema carries spill fields',
    tool.output.schema.properties.stdoutSpill.required.includes('locator') &&
      tool.output.schema.properties.stderrSpill.required.includes('hint'),
  )
  check(
    'outcome enum includes cwd/env errors',
    ['cwd-error', 'env-error', 'status-unknown', 'prep-error', 'ok'].every((o) =>
      tool.output.schema.properties.outcome.enum.includes(o),
    ),
  )
  check(
    'tool description lists default cwds',
    tool.description.includes('gpu (default cwd: /workspace/projects)') && tool.description.includes('other (default cwd: /w2)'),
  )
}
{
  const fake = fakeToolCtx()
  apply(fake.ctx, Config({}))
  const tool = fake.registered[0]
  check(
    'no-target tool has a plain string target parameter',
    tool.parameters.properties.target.enum === undefined && tool.parameters.required.includes('target'),
  )
  check('no-target description says NONE', tool.description.includes('NONE'))
}

// ── Part 8: local fixture through fake ssh/docker + real bash/fish ───────
{
  const root = await mkdtemp(join(tmpdir(), 'remote-exec-fixture-'))
  const bin = join(root, 'bin')
  const fakebin = join(root, 'fakebin')
  const envbin = join(root, 'envbin')
  const exportfailbin = join(root, 'exportfailbin')
  const evalfailbin = join(root, 'evalfailbin')
  const catfailbin = join(root, 'catfailbin')
  const home = join(root, 'home')
  const project = join(root, 'project')
  const envProject = join(root, 'env-project')
  const fishPath = execFileSync('which', ['fish'], { encoding: 'utf8' }).trim()
  await mkdir(bin, { recursive: true })
  await mkdir(fakebin, { recursive: true })
  await mkdir(envbin, { recursive: true })
  await mkdir(exportfailbin, { recursive: true })
  await mkdir(evalfailbin, { recursive: true })
  await mkdir(catfailbin, { recursive: true })
  await mkdir(join(home, '.config', 'fish'), { recursive: true })
  await mkdir(project, { recursive: true })
  await mkdir(envProject, { recursive: true })
  await writeFile(join(home, '.config', 'fish', 'config.fish'), "echo 'LOGIN BANNER' >&2\n")
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nexec bash -s --\n')
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh
set -e
cmd=$1
shift
case "$cmd" in
  inspect)
    format=false
    while [ $# -gt 0 ]; do
      case "$1" in
        -f) format=true; shift 2;;
        *) break;;
      esac
    done
    [ -n "$1" ] || exit 1
    if [ "$format" = true ]; then echo true; fi
    exit 0
    ;;
  start) exit 0;;
  exec)
    while [ $# -gt 0 ]; do
      case "$1" in
        -i) shift;;
        -u|-w) shift 2;;
        *) break;;
      esac
    done
    [ -n "$1" ] || exit 1
    shift
    if [ "$1" = cat ]; then
      case "$2" in
        *remote-exec-*.status)
          if [ "\${FAKE_STATUS_READ_FAIL:-}" = 1 ]; then
            echo 'fake status read failure' >&2
            exit 1
          fi
          if [ "\${FAKE_STATUS_READ_FAIL:-}" = long ]; then
            head -c 50000 /dev/zero | tr '\\0' 'E' >&2
            exit 1
          fi
          ;;
      esac
    fi
    exec "$@"
    ;;
  *) exit 1;;
esac
`,
  )
  await writeFile(join(fakebin, 'direnv'), '#!/bin/sh\necho "fake direnv: failing environment" >&2\nexit 1\n')
  await writeFile(
    join(envbin, 'direnv'),
    '#!/bin/sh\ncase "$1" in\n  allow) exit 0;;\n  export) echo "set -gx REMOTE_EXEC_FIXTURE ok"; exit 0;;\nesac\nexit 1\n',
  )
  await writeFile(
    join(exportfailbin, 'direnv'),
    '#!/bin/sh\ncase "$1" in\n  allow) exit 0;;\n  export) echo "fake export failure" >&2; exit 1;;\nesac\nexit 1\n',
  )
  await writeFile(
    join(evalfailbin, 'direnv'),
    '#!/bin/sh\ncase "$1" in\n  allow) exit 0;;\n  export) echo "definitely_missing_review_command"; exit 0;;\nesac\nexit 1\n',
  )
  const catPath = execFileSync('which', ['cat'], { encoding: 'utf8' }).trim()
  await writeFile(
    join(catfailbin, 'cat'),
    `#!/bin/sh\ncase "$1" in\n  *.status.export) echo "fake cat export failure" >&2; exit 1;;\nesac\nexec ${catPath} "$@"\n`,
  )
  await chmod(join(bin, 'ssh'), 0o755)
  await chmod(join(bin, 'docker'), 0o755)
  await chmod(join(fakebin, 'direnv'), 0o755)
  await chmod(join(envbin, 'direnv'), 0o755)
  await chmod(join(exportfailbin, 'direnv'), 0o755)
  await chmod(join(evalfailbin, 'direnv'), 0o755)
  await chmod(join(catfailbin, 'cat'), 0o755)
  await writeFile(join(envProject, '.envrc'), 'echo env\n')
  const fixtureEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    PATH: `${fakebin}:${bin}:${process.env.PATH}`,
  }
  const envSuccessEnv = { ...fixtureEnv, PATH: `${envbin}:${bin}:${process.env.PATH}` }
  const exportFailEnv = { ...fixtureEnv, PATH: `${exportfailbin}:${bin}:${process.env.PATH}` }
  const evalFailEnv = { ...fixtureEnv, PATH: `${evalfailbin}:${bin}:${process.env.PATH}` }
  const catFailEnv = { ...fixtureEnv, PATH: `${catfailbin}:${envbin}:${bin}:${process.env.PATH}` }
  const statusFailEnv = { ...fixtureEnv, FAKE_STATUS_READ_FAIL: '1' }
  const statusLongEnv = { ...fixtureEnv, FAKE_STATUS_READ_FAIL: 'long' }
  const fixtureSpill = stubSpillStore()
  function fixtureSubprocess(env = fixtureEnv) {
    return {
      ctx: {
        get: (name) => (name === 'spillStore' ? fixtureSpill.store : undefined),
        subprocess: {
          resolveExecutable: async () => join(bin, 'ssh'),
          spawn: (spec) => {
            const child = spawnChild(spec.argv[0], spec.argv.slice(1), {
              cwd: spec.cwd,
              env,
              stdio: ['pipe', 'pipe', 'pipe'],
              detached: true,
            })
            child.stdin.end(spec.stdio.stdin.data)
            const out = []
            const err = []
            child.stdout.on('data', (chunk) => out.push(chunk))
            child.stderr.on('data', (chunk) => err.push(chunk))
            const done = new Promise((resolve) => {
              child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
              spec.signal?.addEventListener(
                'abort',
                () => {
                  try {
                    process.kill(-child.pid, 'SIGTERM')
                  } catch {
                    child.kill('SIGTERM')
                  }
                },
                { once: true },
              )
            })
            const read = (chunks) => {
              const text = Buffer.concat(chunks).toString('utf8')
              return { text, nextOffset: Buffer.byteLength(text), lossy: false }
            }
            return {
              done,
              collected: {
                stdout: { readFrom: () => read(out) },
                stderr: { readFrom: () => read(err) },
              },
            }
          },
        },
      },
    }
  }
  const fixtureTarget = {
    sshHost: 'fake-host',
    container: 'fake-container',
    defaultCwd: project,
    shell: fishPath,
    envInit: 'none',
    autoStart: true,
  }
  async function runFixture(
    command,
    { cwd = project, target = fixtureTarget, displayMaxBytes, timeoutMs = 5000, env = fixtureEnv } = {},
  ) {
    const cfg = Config(displayMaxBytes === undefined ? {} : { displayMaxBytes })
    return new RemoteRunner(fixtureSubprocess(env).ctx, cfg).run('fixture', target, command, {
      cwd,
      timeoutMs,
      owner: { sessionId: 'session-fixture' },
      callId: 'call-fixture',
    })
  }
  try {
    {
      const result = await runFixture("printf 'out-line\\n'; printf 'err-line\\n' >&2; exit 7")
      check(
        'fixture: command stdout/stderr/exit through the real script',
        result.outcome === 'ok' && result.exitCode === 7 && result.stdout === 'out-line\n' && result.stderr === 'err-line\n',
      )
      check('fixture: login-shell banner stays out of command stderr', !result.stderr.includes('LOGIN BANNER'))
      check('fixture: command runs in the requested cwd', result.cwd === project)
      check('fixture: success result is lossless JSON', snapshotJsonValue(result) !== undefined)
    }
    {
      const result = await runFixture('cat')
      check(
        'fixture: command stdin is EOF, not the remote script',
        result.outcome === 'ok' && result.stdout === '' && result.stderr === '',
      )
    }
    {
      const missing = join(root, 'missing')
      const marker = join(root, 'cwd-ran')
      const result = await runFixture(`touch ${marker}`, { cwd: missing })
      check('fixture: missing cwd is a cwd-error', result.outcome === 'cwd-error' && result.detail === 'cwd is not accessible')
      check('fixture: missing cwd does not run the command', !existsSync(marker))
      check(
        'fixture: missing cwd keeps the cd diagnostic',
        result.stderr.includes('missing') || result.stderr.includes('does not exist'),
      )
    }
    {
      const envTarget = { ...fixtureTarget, envInit: 'direnv' }
      const marker = join(root, 'env-ran')
      const result = await runFixture(`touch ${marker}`, { cwd: envProject, target: envTarget })
      check(
        'fixture: failing direnv is an env-error',
        result.outcome === 'env-error' && result.detail === 'environment initialization failed',
      )
      check('fixture: failing direnv does not run the command', !existsSync(marker))
      check('fixture: env log reaches stderr', result.stderr.includes('fake direnv: failing environment'))
    }
    {
      const envTarget = { ...fixtureTarget, envInit: 'direnv' }
      const result = await runFixture("printf '%s\\n' $REMOTE_EXEC_FIXTURE", {
        cwd: envProject,
        target: envTarget,
        env: envSuccessEnv,
      })
      check('fixture: successful direnv export reaches the command', result.outcome === 'ok' && result.stdout === 'ok\n')
      check('fixture: successful env init is silent', result.stderr === '')
    }
    {
      const missingShell = join(root, 'missing-fish')
      const result = await runFixture('echo nope', { target: { ...fixtureTarget, shell: missingShell } })
      check(
        'fixture: missing container shell is status-unknown',
        result.outcome === 'status-unknown' && result.detail.includes('status read failed'),
      )
      check('fixture: start failure keeps the shell error', result.stderr.includes('missing-fish') || result.stderr.includes('not found'))
      check('fixture: start failure does not claim NOT started', !formatResult(result).includes('NOT started'))
    }
    {
      const result = await runFixture('echo COMMAND_DID_RUN', { env: statusFailEnv })
      check('fixture: status read failure is status-unknown', result.outcome === 'status-unknown')
      check('fixture: status read failure keeps the command output', result.stdout === 'COMMAND_DID_RUN\n')
      check('fixture: status read failure detail stays short', result.detail.includes('status read failed'))
      check('fixture: status read failure keeps the underlying error in stderr', result.stderr.includes('fake status read failure'))
      check('fixture: status read failure does not claim NOT started', !formatResult(result).includes('NOT started'))
    }
    {
      const result = await runFixture('echo COMMAND_DID_RUN', { displayMaxBytes: 1024, env: statusLongEnv })
      check('fixture: long status error is status-unknown', result.outcome === 'status-unknown')
      check('fixture: long status error keeps the command output', result.stdout === 'COMMAND_DID_RUN\n')
      check('fixture: long status error detail stays short', Buffer.byteLength(result.detail, 'utf8') <= 100)
      check('fixture: long status error is bounded in the model view', Buffer.byteLength(result.stderr, 'utf8') <= 1024)
      check('fixture: long status error reports the raw total', result.stderrBytes >= 50000)
      check('fixture: long status error is marked truncated', result.stderrTruncated === true)
      check('fixture: long status error has a spill locator', result.stderrSpill !== undefined)
      check(
        'fixture: long status error render is bounded',
        Buffer.byteLength(formatResult(result), 'utf8') <= 2048,
      )
      check(
        'fixture: long status error is retrievable from the spill',
        fixtureSpill.saves.some((save) => save.content.includes('E'.repeat(1000))),
      )
    }
    {
      const envTarget = { ...fixtureTarget, envInit: 'direnv' }
      const marker = join(root, 'exportfail-ran')
      const result = await runFixture(`touch ${marker}`, { cwd: envProject, target: envTarget, env: exportFailEnv })
      check('fixture: direnv export failure is env-error', result.outcome === 'env-error')
      check('fixture: direnv export failure does not run the command', !existsSync(marker))
      check('fixture: direnv export failure keeps its diagnostic', result.stderr.includes('fake export failure'))
    }
    {
      const envTarget = { ...fixtureTarget, envInit: 'direnv' }
      const marker = join(root, 'evalfail-ran')
      const result = await runFixture(`touch ${marker}`, { cwd: envProject, target: envTarget, env: evalFailEnv })
      check('fixture: direnv eval failure is env-error', result.outcome === 'env-error')
      check('fixture: direnv eval failure does not run the command', !existsSync(marker))
      check(
        'fixture: direnv eval failure keeps the fish error',
        result.stderr.includes('definitely_missing_review_command'),
      )
    }
    {
      const envTarget = { ...fixtureTarget, envInit: 'direnv' }
      const marker = join(root, 'catfail-ran')
      const result = await runFixture(`touch ${marker}`, { cwd: envProject, target: envTarget, env: catFailEnv })
      check('fixture: export-file read failure is env-error', result.outcome === 'env-error')
      check('fixture: export-file read failure does not run the command', !existsSync(marker))
      check('fixture: export-file read failure keeps the cat error', result.stderr.includes('fake cat export failure'))
    }
    {
      const result = await runFixture('seq 1 5000', { displayMaxBytes: 1024 })
      check(
        'fixture: large output is truncated for the model',
        result.outcome === 'ok' && result.stdoutTruncated === true && Buffer.byteLength(result.stdout, 'utf8') <= 1024,
      )
      check('fixture: full output is saved to the spill store', fixtureSpill.saves.some((save) => save.content.includes('5000')))
      check('fixture: large-output result carries a spill locator', result.stdoutSpill !== undefined)
    }
    {
      const result = await runFixture('exit 255')
      check('fixture: command exit 255 stays ok', result.outcome === 'ok' && result.exitCode === 255)
    }
    {
      const started = Date.now()
      const result = await runFixture('sleep 0.5', { timeoutMs: 100 })
      check('fixture: timeout is unknown, not failed', result.outcome === 'timeout-unknown' && !('exitCode' in result))
      check('fixture: timeout returns before the remote sleep finishes', Date.now() - started < 1500)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
