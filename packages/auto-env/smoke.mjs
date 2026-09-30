/* Runtime smoke test for dsh-auto-env.
 *
 * Part 1 — plugin surface: config defaults, class shape, inject list.
 * Part 2 — pure helpers: dump sanitizing (tombstones + DSH_/DIRENV_
 *          stripping) and overlay merge precedence.
 * Part 3 — DirenvLoader against a scripted fake direnv behind a stub
 *          `ctx.subprocess`: none / active / cache / upward walk /
 *          revalidate / in-flight dedup / blocked / timeout / error /
 *          missing-binary classification.
 *
 * The real direnv binary is deliberately not exercised here (the model bash
 * sandbox denies its allow-record writes — the reason the plugin evaluates
 * direnv host-side in the first place); see the package README for the live
 * verification recipe.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoEnvBashExecutor, Config, DirenvLoader, findEnvrcDir, mergeOverlay, sanitizeDirenvDump } from './lib/index.js'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'

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
const config = Config({})
console.log('defaults:', JSON.stringify(config))
check('default timeoutMs', config.timeoutMs === 120000)
check('default maxTimeoutMs', config.maxTimeoutMs === 600000)
check('default maxOutputBytes', config.maxOutputBytes === 64000)
check('default graceMs', config.graceMs === 3000)
check('cwd stays optional', config.cwd === undefined)
check('default direnvPath', config.direnvPath === 'direnv')
check('default direnvTimeoutMs', config.direnvTimeoutMs === 30000)
check('default direnvRevalidateMs', config.direnvRevalidateMs === 30000)
check('default direnvStdoutMaxBytes', config.direnvStdoutMaxBytes === 1048576)
check('class extends SandboxBashExecutor', Object.getPrototypeOf(AutoEnvBashExecutor) === SandboxBashExecutor)
check('inject adds shellEnv to the parents set', AutoEnvBashExecutor.inject.join(',') === ['subprocess', 'sandbox', 'sandboxPolicy', 'shellEnv'].join(','))
check('static Config is the exported schema', AutoEnvBashExecutor.Config === Config)
const resolved = Config({ timeoutMs: 60000 })
check('row-style partial config keeps direnv defaults', resolved.timeoutMs === 60000 && resolved.direnvPath === 'direnv')

// ── Part 2: pure helpers ──────────────────────────────────────────────────
const sanitized = sanitizeDirenvDump({
  FOO: 'bar',
  NIX_PATH: null,
  DSH_FAKE: 'must-not-cross',
  DIRENV_DIR: '-/must-not-cross',
  NUMBER: 42,
})
check('sanitizer keeps plain values', sanitized.FOO === 'bar' && sanitized.NUMBER === '42')
check('sanitizer turns null into a tombstone', 'NIX_PATH' in sanitized && sanitized.NIX_PATH === undefined)
check('sanitizer strips DSH_/DIRENV_ keys', !('DSH_FAKE' in sanitized) && !('DIRENV_DIR' in sanitized))

const spec = { command: 'x', workdir: '/w', timeoutMs: 1000, stdoutMaxBytes: 1, env: { A: 'caller' } }
const merged = mergeOverlay(spec, { A: 'direnv', B: 'set', C: undefined })
check('merge keeps caller env on top', merged.env.A === 'caller')
check('merge layers overlay below it', merged.env.B === 'set')
check('merge carries unset tombstones', 'C' in merged.env && merged.env.C === undefined)
check('empty overlay returns the spec untouched', mergeOverlay(spec, {}) === spec)

// ── Part 3: DirenvLoader against a scripted fake direnv ───────────────────
const spawns = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function fakeHandle(done, stdout, stderr) {
  return {
    done,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
    },
    terminate() {},
  }
}
function readOptional(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
const stubCtx = {
  logger() {
    return { info() {}, warn() {} }
  },
  subprocess: {
    async resolveExecutable(name) {
      if (name === 'no-such-direnv') throw new Error('not found')
      return `/fake/bin/${name}`
    },
    spawn(request) {
      spawns.push(request.cwd)
      const rc = request.cwd
      if (readOptional(join(rc, 'hang')) !== undefined) {
        return fakeHandle(
          new Promise((resolve) => {
            if (request.signal?.aborted) return resolve({ exitCode: null, signal: 'SIGKILL' })
            request.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGKILL' }), { once: true })
          }),
          '',
          '',
        )
      }
      if (readOptional(join(rc, 'slow')) !== undefined) {
        return fakeHandle(sleep(30).then(() => ({ exitCode: 0, signal: null })), readOptional(join(rc, 'dump.json')) ?? '', '')
      }
      if (readOptional(join(rc, 'blocked')) !== undefined) {
        return fakeHandle(Promise.resolve({ exitCode: 1, signal: null }), '', `${rc}/.envrc is blocked. Run \`direnv allow\` to approve its content.\n`)
      }
      return fakeHandle(Promise.resolve({ exitCode: 0, signal: null }), readOptional(join(rc, 'dump.json')) ?? '', '')
    },
  },
}
const root = join(tmpdir(), 'dsh-auto-env-smoke')
rmSync(root, { recursive: true, force: true })
// DirenvLoader watches XDG_DATA_HOME/direnv/allow when active; point it at a
// throwaway location so the allow-list test below is hermetic.
process.env.XDG_DATA_HOME = join(root, 'xdg-data')
function scenario(name, files) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content)
  return dir
}
mkdirSync(join(root, 'xdg-data', 'direnv', 'allow'), { recursive: true })
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const loader = new DirenvLoader(stubCtx, { direnvPath: 'direnv', timeoutMs: 50, revalidateMs: 60_000, stdoutMaxBytes: 65536 })

// none: no .envrc anywhere in the chain
const plainDir = scenario('plain', {})
const noneOverlay = await loader.ensure(plainDir)
check('no .envrc → empty overlay with none status', Object.keys(noneOverlay).length === 0 && loader.status(plainDir).status === 'none')
check('no .envrc → snapshot serves empty, not undefined', loader.snapshot(plainDir) !== undefined)

// active: a full direnv JSON diff
const activeDir = scenario('active', {
  '.envrc': 'export FOO=bar\n',
  'dump.json': JSON.stringify({ FOO: 'bar', PATH: '/opt/devenv/bin:/usr/bin', NIX_PATH: null, DIRENV_DIFF: 'zz==', DSH_FAKE: 'x' }),
})
const overlay = await loader.ensure(activeDir)
check('active: overlay parsed from the dump', overlay.FOO === 'bar' && overlay.PATH === '/opt/devenv/bin:/usr/bin')
check('active: null becomes a tombstone', 'NIX_PATH' in overlay && overlay.NIX_PATH === undefined)
check('active: DIRENV_/DSH_ stripped', !('DIRENV_DIFF' in overlay) && !('DSH_FAKE' in overlay))
check('active: status reports the rc dir', loader.status(activeDir).status === 'active' && loader.status(activeDir).rcDir === activeDir)
check('active: one spawn so far', spawns.length === 1)

// cached: same rc dir served from cache, including from a subdirectory
const subDir = scenario('active/nested/deeper', {})
await loader.ensure(activeDir)
await loader.ensure(subDir)
check('cache: rc dir + subdir served without a new spawn', spawns.length === 1)
check('cache: snapshot is warm', loader.snapshot(subDir)?.FOO === 'bar')

// revalidate: a zero-TTL loader re-runs direnv per ensure
const freshLoader = new DirenvLoader(stubCtx, { direnvPath: 'direnv', timeoutMs: 50, revalidateMs: 0, stdoutMaxBytes: 65536 })
await freshLoader.ensure(activeDir)
await freshLoader.ensure(activeDir)
check('revalidate: zero TTL spawns twice', spawns.length === 3)

// in-flight dedup: concurrent ensures share one evaluation
const slowDir = scenario('slow', { '.envrc': '', 'dump.json': '{"FOO":"bar"}', slow: '' })
const before = spawns.length
await Promise.all([freshLoader.ensure(slowDir), freshLoader.ensure(slowDir), freshLoader.ensure(slowDir)])
check('in-flight: three concurrent ensures → one spawn', spawns.length === before + 1)

// blocked: direnv refuses an unallowed .envrc
const blockedDir = scenario('blocked', { '.envrc': 'export X=1\n', blocked: '' })
const blockedOverlay = await loader.ensure(blockedDir)
check('blocked: empty overlay', Object.keys(blockedOverlay).length === 0)
check('blocked: status classified from stderr', loader.status(blockedDir).status === 'blocked')

// timeout: a hanging evaluation is cut by the budget
const hangDir = scenario('hang', { '.envrc': '', hang: '' })
const hangOverlay = await loader.ensure(hangDir)
check('timeout: empty overlay', Object.keys(hangOverlay).length === 0)
check('timeout: status classified', loader.status(hangDir).status === 'timeout')

// error: invalid JSON output
const errorDir = scenario('badjson', { '.envrc': '', 'dump.json': 'not json{' })
await loader.ensure(errorDir)
check('error: invalid dump classified', loader.status(errorDir).status === 'error')

// missing: the direnv binary itself cannot be resolved
const missingLoader = new DirenvLoader(stubCtx, { direnvPath: 'no-such-direnv', timeoutMs: 50, revalidateMs: 60_000, stdoutMaxBytes: 65536 })
await missingLoader.ensure(activeDir)
check('missing: unresolvable binary classified', missingLoader.status(activeDir).status === 'missing')

// watcher: editing an .envrc input drops the cache despite the 60s TTL
const beforeWatch = spawns.length
writeFileSync(join(activeDir, 'dump.json'), JSON.stringify({ FOO: 'baz' }))
writeFileSync(join(activeDir, '.envrc'), 'export FOO=baz\n')
await sleepMs(200)
const refreshed = await loader.ensure(activeDir)
check('watcher: .envrc change re-evaluates despite TTL', spawns.length === beforeWatch + 1 && refreshed.FOO === 'baz')

// watcher: a change DURING an in-flight evaluation discards the stale result.
// Long TTL, so only the invalidation (not age) can force the second spawn.
const raceLoader = new DirenvLoader(stubCtx, { direnvPath: 'direnv', timeoutMs: 5_000, revalidateMs: 60_000, stdoutMaxBytes: 65536 })
writeFileSync(join(slowDir, 'dump.json'), '{"FOO":"late"}')
writeFileSync(join(slowDir, '.envrc'), '')
const beforeRace = spawns.length
const slowStart = raceLoader.ensure(slowDir)
await sleepMs(10)
writeFileSync(join(slowDir, '.envrc'), '# touched mid-eval\n')
await slowStart
await raceLoader.ensure(slowDir)
check('watcher: mid-eval change discards the stale result', spawns.length === beforeRace + 2)

// watcher: disabled → TTL alone governs (no respawn on edit)
const noWatchLoader = new DirenvLoader(stubCtx, { direnvPath: 'direnv', timeoutMs: 50, revalidateMs: 60_000, stdoutMaxBytes: 65536, watch: false })
await noWatchLoader.ensure(activeDir)
const beforeNoWatch = spawns.length
writeFileSync(join(activeDir, '.envrc'), 'export FOO=qux\n')
await sleepMs(200)
await noWatchLoader.ensure(activeDir)
check('watcher: disabled loader keeps serving the cached overlay', spawns.length === beforeNoWatch)

// allow list: an interactive `direnv allow` invalidates every environment
const beforeAllow = spawns.length
writeFileSync(join(root, 'xdg-data', 'direnv', 'allow', 'deadbeef'), '')
await sleepMs(200)
await loader.ensure(activeDir)
check('allow list: a new allow record invalidates cached overlays', spawns.length === beforeAllow + 1)

loader.dispose()
raceLoader.dispose()
noWatchLoader.dispose()
missingLoader.dispose()

// upward walk: findEnvrcDir mirrors direnv's own search
check('findEnvrcDir walks up to the nearest .envrc', findEnvrcDir(subDir) === activeDir && findEnvrcDir(plainDir) === undefined)

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nsmoke: all checks passed' : `\nsmoke: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
