/* Runtime smoke test for dsh-remote-exec.
 *
 * Part 1 — plugin surface: config defaults, target-dict defaults.
 * Part 2 — exec.ts protocol: shQuote, buildRemoteScript (autoStart on/off,
 *          envInit, quoting layers, prep markers/exits), buildSshArgv
 *          ordering, classifyOutcome truth table.
 * Part 3 — GrantStore session memory + eviction.
 *
 * The real ssh/docker path is deliberately not exercised here (no target is
 * reachable from CI, and host-side ssh needs the operator's ~/.ssh); see the
 * package README for the live verification recipe.
 */
import { Config, GrantStore } from './lib/index.js'
import {
  DEFAULT_CONTAINER_SHELL,
  PREP_EXIT_CODE,
  PREP_MARKER,
  buildRemoteScript,
  buildSshArgv,
  classifyOutcome,
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

// ── Part 1: plugin surface ────────────────────────────────────────────────
const defaults = Config({})
check('default sshPath', defaults.sshPath === 'ssh')
check('default approvalMode', defaults.approvalMode === 'session')
check('default timeoutMs', defaults.defaultTimeoutMs === 600000)
check('default maxTimeoutMs', defaults.maxTimeoutMs === 3600000)
check('default startTimeoutMs', defaults.startTimeoutMs === 60000)
check('default graceMs', defaults.graceMs === 5000)
check('default stdout/stderr budgets', defaults.stdoutMaxBytes === 1048576 && defaults.stderrMaxBytes === 65536)
check('default targets is an empty dict', Array.isArray(Object.keys(defaults.targets)) && Object.keys(defaults.targets).length === 0)

const withTarget = Config({ targets: { box: { sshHost: 'gpu', container: 'nav', workdir: '/w' } } })
const box = withTarget.targets.box
check(
  'target defaults filled by the dict schema',
  box.shell === DEFAULT_CONTAINER_SHELL && box.autoStart === true && box.envInit === 'direnv' && box.containerUser === undefined,
)
check('target required fields survive', box.sshHost === 'gpu' && box.container === 'nav' && box.workdir === '/w')

// ── Part 2: protocol ──────────────────────────────────────────────────────
check('shQuote plain', shQuote('plain') === "'plain'")
check('shQuote with single quote', shQuote("a'b") === "'a'\\''b'")
check('shQuote empty', shQuote('') === "''")

const target = {
  sshHost: 'gpu-workstation',
  container: 'mini-nav',
  workdir: '/workspace/Mini-Nav',
  shell: DEFAULT_CONTAINER_SHELL,
  envInit: 'direnv',
  autoStart: true,
}
const script = buildRemoteScript(target, { command: 'just train', startAttempts: 30 })
check('script pins bash safety net', script.startsWith('set -Eeuo pipefail'))
check('script docker-execs the named container', script.includes('exec docker exec -i') && script.includes("'mini-nav'"))
check('script quotes the workdir', script.includes("-w '/workspace/Mini-Nav'"))
check('script resolves uid:gid remotely by default', script.includes('-u "$(id -u):$(id -g)"'))
check('inner fish bootstrap present', script.includes('fish_add_path -g $HOME/.nix-profile/bin; if test -f .envrc;'))
check('model command lands inside the inner fish -c quotes', script.includes("-l -c 'fish_add_path") && script.includes("; just train'"))
check('autoStart branch starts and polls', script.includes('docker start') && script.includes('-ge 30'))
check('prep errors use the marker + distinct exit', script.includes(`${PREP_MARKER} docker not found`) && script.includes(`exit ${PREP_EXIT_CODE}`))
check('prep has no host-shell fallback', !script.includes('fish -l -c') || script.includes('exec docker exec'))

const noStart = buildRemoteScript({ ...target, autoStart: false }, { command: 'ls', startAttempts: 5 })
check('autoStart disabled is a terminal prep error', noStart.includes('autoStart is disabled') && !noStart.includes('docker start'))

const noDirenv = buildRemoteScript({ ...target, envInit: 'none' }, { command: 'ls', startAttempts: 5 })
check('envInit none skips the direnv block', !noDirenv.includes('direnv export') && noDirenv.includes('fish_add_path'))

const hostile = buildRemoteScript(
  { ...target, envInit: 'none', workdir: `/w'; rm -rf /; '` },
  { command: "echo '; rm -rf /; '", startAttempts: 5 },
)
check('workdir single-quotes are neutralized', hostile.includes("-w '/w'\\''; rm -rf /; '\\''"))
check('command stays inside the fish -c string', hostile.includes("-c 'fish_add_path -g $HOME/.nix-profile/bin; echo '\\''; rm -rf /; '\\''"))

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

check('classify ok', classifyOutcome(0, '', false, false) === 'ok')
check('classify prep-error by marker', classifyOutcome(PREP_EXIT_CODE, `${PREP_MARKER} boom`, false, false) === 'prep-error')
check('classify plain exit 86 without marker stays ok', classifyOutcome(PREP_EXIT_CODE, '', false, false) === 'ok')
check('classify ssh-error 255', classifyOutcome(255, 'ssh: connect', false, false) === 'ssh-error')
check('classify signal death without flags is ssh-error', classifyOutcome(null, '', false, false) === 'ssh-error')
check('classify timeout wins over exit 0', classifyOutcome(0, '', true, false) === 'timeout-unknown')
check('classify cancel wins over exit 0', classifyOutcome(0, '', false, true) === 'cancelled-unknown')
check('classify timeout wins over cancel', classifyOutcome(0, '', true, true) === 'timeout-unknown')

// ── Part 3: GrantStore ────────────────────────────────────────────────────
const grants = new GrantStore()
grants.add('s1', 'gpu')
check('grant visible in the same session', grants.has('s1', 'gpu'))
check('grant invisible in another session', !grants.has('s2', 'gpu'))
check('grant is per target', !grants.has('s1', 'other'))
grants.add('s1', 'other')
check('second target granted in same session', grants.has('s1', 'other'))
for (let i = 0; i < 400; i += 1) grants.add(`bulk-${i}`, 'gpu')
check('eviction drops the oldest sessions', !grants.has('bulk-0', 'gpu') && grants.has('bulk-399', 'gpu'))

// ── Part 4: RemoteRunner against a stub ctx.subprocess ───────────────────
//
// Regression body for the "value is not lossless JSON" failure: a tool value
// with a property explicitly set to undefined fails snapshotJsonValue (the
// exact validator dsh-tools runs on every tool result), so run() must OMIT
// optional keys instead of assigning undefined. Each case below feeds the
// result through the real snapshotJsonValue imported from dsh-util-values.
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { Config as makeConfig, RemoteRunner } from './lib/index.js'

const cfg = makeConfig({})
function stubSubprocess({ exitCode = 0, stdout = '', stderr = '', lossy = false, hang = false, resolveThrows = null } = {}) {
  const spawns = []
  return {
    spawns,
    subprocess: {
      resolveExecutable: async () => {
        if (resolveThrows !== null) throw resolveThrows
        return '/usr/bin/ssh'
      },
      spawn: (spec) => {
        spawns.push(spec)
        return {
          done:
            hang
              ? new Promise((resolve) => {
                  spec.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
                })
              : Promise.resolve({ exitCode }),
          collected: {
            stdout: { readFrom: () => ({ text: stdout, lossy }) },
            stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
          },
        }
      },
    },
  }
}
const t = { sshHost: 'gpu', container: 'nav', workdir: '/w', shell: '/bin/fish', envInit: 'none', autoStart: false }

{
  const stub = stubSubprocess({ exitCode: 0, stdout: 'ok\n' })
  const result = await new RemoteRunner(stub, cfg).run('gpu', t, 'echo ok', { timeoutMs: 5000 })
  check('runner ok path classified', result.outcome === 'ok' && result.exitCode === 0 && result.stdout === 'ok\n')
  check('runner ok result is lossless JSON', snapshotJsonValue(result) !== undefined)
  check('runner feeds the script on stdin', stub.spawns[0].stdio.stdin.data.includes('docker exec') && stub.spawns[0].argv.at(-3) === 'bash')
}
{
  const stub = stubSubprocess({ exitCode: null })
  const result = await new RemoteRunner(stub, cfg).run('gpu', t, 'ls', { timeoutMs: 5000 })
  check('runner signal death → ssh-error without exitCode key', result.outcome === 'ssh-error' && !('exitCode' in result))
  check('runner ssh-error result is lossless JSON', snapshotJsonValue(result) !== undefined)
}
{
  const stub = stubSubprocess({ hang: true })
  const result = await new RemoteRunner(stub, cfg).run('gpu', t, 'sleep 100', { timeoutMs: 100 })
  check('runner timeout → timeout-unknown without exitCode key', result.outcome === 'timeout-unknown' && !('exitCode' in result) && !('lossy' in result))
  check('runner timeout result is lossless JSON', snapshotJsonValue(result) !== undefined)
}
{
  const stub = stubSubprocess({ exitCode: 1, stdout: 'x'.repeat(10), lossy: true })
  const result = await new RemoteRunner(stub, cfg).run('gpu', t, 'cat big', { timeoutMs: 5000 })
  check('runner lossy flag carried', result.lossy === true)
  check('runner lossy result is lossless JSON', snapshotJsonValue(result) !== undefined)
}
{
  const stub = stubSubprocess({ resolveThrows: new Error('ssh not found') })
  const result = await new RemoteRunner(stub, cfg).run('gpu', t, 'ls', { timeoutMs: 5000 })
  check('runner spawn-error classified', result.outcome === 'spawn-error' && result.stderr === 'ssh not found')
  check('runner spawn-error result is lossless JSON', snapshotJsonValue(result) !== undefined)
}
check(
  'no result ever carries an undefined property value',
  [await new RemoteRunner(stubSubprocess({ exitCode: 0 }), cfg).run('gpu', t, 'ls', { timeoutMs: 5000 })].every(
    (result) => Object.values(result).every((v) => v !== undefined),
  ),
)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
