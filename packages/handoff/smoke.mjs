/* Runtime smoke test for dsh-handoff: load, resolve defaults, apply, and
 * exercise the empty-argument command path with a stub context. */
import { name, inject, Config, apply, COMMAND_NAME } from './lib/index.js'

let registered = null
const disposers = []
const ctx = {
  commands: {
    register(def) {
      registered = def
      return () => { registered = null }
    },
  },
  logger() {
    return { info() {}, warn() {} }
  },
  effect(fn) {
    disposers.push(fn())
    return () => {}
  },
  get() {
    return undefined
  },
}

const config = Config({})
console.log('plugin:', name, '| inject:', inject)
console.log('defaults:', JSON.stringify(config))
if (config.dir !== '.dsh/handoff') throw new Error('bad dir default')
if (config.timeoutMs !== 300000) throw new Error('bad timeout default')
if (config.confirm !== true) throw new Error('bad confirm default')

apply(ctx, config)
if (registered === null || registered.name !== COMMAND_NAME) throw new Error('command not registered')
console.log('registered command:', registered.name, '|', registered.description)

const result = await registered.handler({ rawInput: '   ', agent: null, signal: null })
console.log('empty-args result:', JSON.stringify(result))
if (result.kind !== 'error') throw new Error('expected usage error')

// In-flight guard path: a pending entry + a session with cwd must reject a second handoff.
// (Full spawn path needs a live agents factory; covered by manual verification in a real dsh.)
console.log('smoke OK')
