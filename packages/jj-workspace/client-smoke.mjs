/* Wiring smoke test for the browser half: load the module through a fake
 * __ModuleLoader__, apply it to a fake client context, and verify the slot
 * registration, inject face, and Forge Remote delegation. The browser (not
 * this script) owns rendering and effects. */
let failures = 0
function check(label, condition) {
  if (condition) console.log('ok -', label)
  else {
    failures += 1
    console.error('FAIL -', label)
  }
}

const React = {
  createElement: () => null,
  useState: (value) => [value, () => {}],
  useEffect: () => {},
}

let factory
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      factory = definition.factory
    },
  },
}

await import('./client/client.js')
check('module loader receives the client factory', typeof factory === 'function')
const client = factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected module ${name}`)
})
check('client exports apply and inject', typeof client.apply === 'function' && Array.isArray(client.inject))

const calls = []
const registrations = {}
let slotName
let slotRegistration
const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  // The worktree control is scoped to the Forge Remote namespace. This fake
  // context represents a page where that namespace is already mounted.
  inject(_deps, callback) {
    return callback(ctx)
  },
  locale: {
    register() {},
    bind() {
      return (key, params) => (params === undefined ? key : `${key}:${params.message ?? ''}`)
    },
  },
  slots: {
    inject(name, callback) {
      calls.push(name)
      slotName = name
      registrations[name] = {}
      registrations[name].value = callback()
      return () => {}
    },
    register(options, component) {
      registrations[slotName] = { ...registrations[slotName], options, component }
      return () => {}
    },
  },
  remote: {
    forgePanel: {
      requestWorktree(sessionId, from) {
        calls.push(['requestWorktree', sessionId, from])
        return Promise.resolve({ ok: true })
      },
      cancelWorktree(sessionId) {
        calls.push(['cancelWorktree', sessionId])
        return Promise.resolve({ ok: true })
      },
      follow(sessionId) {
        calls.push(['follow', sessionId])
        return (async function* () {
          yield { worktree: { request: null, created: null, locked: false, cwd: '/project' } }
        })()
      },
    },
  },
}

client.apply(ctx)
check('client injects the hero options slot', calls.includes('conversation.hero.options'))
const hero = registrations['conversation.hero.options']
const header = registrations['conversation.session.header.utilities']
check('client shadows the stock worktree cell', hero.options.id === 'forge-panel.worktree' && hero.options.priority === -1)
check('client keeps a locale namespace', hero.options.locale === 'jj-workspace')
check('client registers the toggle component', typeof hero.component === 'function')
check('client registers the task pill', header.options.id === 'jj-workspace.task' && typeof header.component === 'function')
const face = hero.options.inject('session-1')
check('inject face exposes status, follow, branches, request, cancel, and copy', typeof face.status === 'function' && typeof face.follow === 'function' && typeof face.branches === 'function' && typeof face.request === 'function' && typeof face.cancel === 'function' && typeof face.t === 'function')
const taskFace = header.options.inject('session-1')
check('task face exposes copy and tasks', typeof taskFace.t === 'function' && typeof taskFace.tasks === 'function')

const frames = []
for await (const frame of face.follow(new AbortController().signal)) frames.push(frame)
check('follow opens the stock Forge panel stream', frames.length === 1 && frames[0].worktree.request === null)

await face.request(null)
await face.cancel()
check('request delegates to the stock Forge Remote', calls.some((entry) => Array.isArray(entry) && entry[0] === 'requestWorktree' && entry[1] === 'session-1' && entry[2] === null))
check('cancel delegates to the stock Forge Remote', calls.some((entry) => Array.isArray(entry) && entry[0] === 'cancelWorktree' && entry[1] === 'session-1'))

process.exitCode = failures === 0 ? 0 : 1
