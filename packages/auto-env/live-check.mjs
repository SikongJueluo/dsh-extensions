/* Live check: run the real DirenvLoader against the real direnv binary.
 *
 * Not part of `pnpm smoke` (the model bash sandbox denies direnv's allow
 * record writes — run manually with full access):
 *   direnv allow .live-probe && node live-check.mjs "$PWD/.live-probe"
 */
import { spawn } from 'node:child_process'
import { DirenvLoader, mergeOverlay } from './lib/index.js'

const ctx = {
  logger(name) {
    return { info: (...a) => console.log(`[${name}]`, ...a), warn: (...a) => console.log(`[${name} warn]`, ...a) }
  },
  subprocess: {
    async resolveExecutable(name) {
      return name
    },
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => { out += d })
      child.stderr.on('data', (d) => { err += d })
      const done = new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
        spec.signal?.addEventListener('abort', () => child.kill('SIGKILL'))
      })
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: out, lossy: false }) },
          stderr: { readFrom: () => ({ text: err, lossy: false }) },
        },
        terminate() {
          child.kill('SIGKILL')
        },
      }
    },
  },
}

const dir = process.argv[2]
const loader = new DirenvLoader(ctx, {
  direnvPath: '/etc/profiles/per-user/sikongjueluo/bin/direnv',
  timeoutMs: 20_000,
  revalidateMs: 30_000,
  stdoutMaxBytes: 1_048_576,
})
const overlay = await loader.ensure(dir)
console.log('status:', JSON.stringify(loader.status(dir)))
console.log('overlay keys:', Object.keys(overlay).length)
console.log('PATH prefix:', overlay.PATH?.split(':')[0])
console.log('AUTO_ENV_PROBE:', overlay.AUTO_ENV_PROBE)
console.log('NIX_PATH tombstone present:', 'NIX_PATH' in overlay && overlay.NIX_PATH === undefined)
const merged = mergeOverlay({ command: 'x', workdir: dir, timeoutMs: 1000, stdoutMaxBytes: 1 }, overlay)
console.log('merged env AUTO_ENV_PROBE:', merged.env?.AUTO_ENV_PROBE, '| merged NIX_PATH:', merged.env?.NIX_PATH)
const again = await loader.ensure(dir)
console.log('second ensure identical:', again === overlay)
process.exit(0)
