// Smoke checks for the pure pieces (run after `pnpm build`):
//   node packages/rtk-rewrite/smoke.mjs
import { RtkBashExecutor, Config, RewriteCache, rewrittenFromStdout } from './lib/index.js'

let failed = 0
function check(name, ok) {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`)
  if (!ok) failed += 1
}

check('plain stdout is the rewrite', rewrittenFromStdout('rtk git status') === 'rtk git status')
check('trailing newline trimmed', rewrittenFromStdout('rtk git status\n') === 'rtk git status')
check('empty stdout means no rewrite', rewrittenFromStdout('') === undefined)
check('whitespace-only stdout means no rewrite', rewrittenFromStdout('  \n ') === undefined)
check('multi-line stdout rejected (diagnostics)', rewrittenFromStdout('rtk git status\nusage: …') === undefined)

const cache = new RewriteCache(2)
cache.set('git status', 'rtk git status')
cache.set('echo hi', null)
check('rewrite answer cached', cache.get('git status') === 'rtk git status')
check('null answer cached (no re-query)', cache.get('echo hi') === null)
check('miss reported as undefined', cache.get('cargo build') === undefined)
cache.set('cargo build', 'rtk cargo build')
check('capacity evicts oldest', cache.size === 2 && cache.get('git status') === undefined)
check('recent entries survive eviction', cache.get('cargo build') === 'rtk cargo build')

const fields = Object.keys(Config.dict ?? {})
check('config extends auto-env executor fields', fields.includes('timeoutMs') && fields.includes('direnvPath'))
check('config adds rtk fields', fields.includes('rewrite') && fields.includes('rtkPath') && fields.includes('rewriteTimeoutMs'))
check('inject mirrors the executor chain', RtkBashExecutor.inject.join(',') === 'subprocess,sandbox,sandboxPolicy,shellEnv')

process.exit(failed === 0 ? 0 : 1)
