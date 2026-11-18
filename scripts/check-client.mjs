#!/usr/bin/env node
/** @module scripts/check-client */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const nodeRequire = createRequire(import.meta.url)
const React = nodeRequire('react')
const { renderToStaticMarkup } = nodeRequire('react-dom/server')

const { registerHooks } = nodeRequire('node:module')

const canMaterializeHostEsm = typeof registerHooks === 'function'
if (canMaterializeHostEsm) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('.css')) {
        return {
          format: 'module',
          source: 'export default new Proxy({}, { get: (_, key) => String(key) })',
          shortCircuit: true,
        }
      }
      return nextLoad(url, context)
    },
  })
}

const consoleError = console.error
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server'))
    return
  consoleError(...args)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const PLATFORM_REQUESTS = new Set([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
])

const HOST_REQUESTS = new Set(['@deepseek-ai/dsh-client-ui-primitives'])
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'

const stubComponent = () => null

function stubHostPrimitives() {
  return new Proxy({}, { get: () => stubComponent })
}

function checkRequire(request) {
  if (!canMaterializeHostEsm && request === PRIMITIVES) return stubHostPrimitives()
  return nodeRequire(request)
}

const failures = []

const catalog = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
const pinnedPrimitives = catalog.match(
  /^\s+'@deepseek-ai\/dsh-client-ui-primitives':\s*(\S+)\s*$/mu,
)?.[1]
if (pinnedPrimitives === undefined) {
  failures.push(['catalog', [`${PRIMITIVES} is not pinned in pnpm-workspace.yaml`]])
} else {
  try {
    const installed = JSON.parse(
      readFileSync(join(root, 'node_modules', PRIMITIVES, 'package.json'), 'utf8'),
    ).version
    if (installed !== pinnedPrimitives) {
      failures.push([
        'catalog',
        [`installed ${PRIMITIVES} ${installed} != pinned ${pinnedPrimitives}`],
      ])
    }
  } catch {
    failures.push(['catalog', [`${PRIMITIVES} is not installed; run pnpm install`]])
  }
}

function fakeElement() {
  return {
    attributes: {},
    textContent: '',
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    remove() {},
  }
}

function createDocument() {
  const appended = []
  return {
    appended,
    createElement: () => fakeElement(),
    querySelector: () => null,
    head: {
      appendChild(element) {
        appended.push(element)
      },
    },
  }
}

const call = () => Promise.resolve({ ok: false })

function createRemote() {
  const node = new Proxy(call, {
    get: () => node,
    apply: () => Promise.resolve({ ok: false }),
  })
  return new Proxy({}, { get: () => node })
}

function createContext(registrations, cleanups) {
  const context = {
    effect(effect) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    get(name) {
      if (name === 'workspaces') {
        const snapshot = { items: [] }
        return { list: { getSnapshot: () => snapshot, subscribe: () => () => {} } }
      }
      if (name === 'sessions') return { binding: () => undefined }
      return undefined
    },
    logger: () => ({
      debug() {},
      info() {},
      warn() {},
      error() {},
    }),
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject(_name, register) {
        register()
      },
      register(options, component) {
        registrations.push({ options, component })
      },
    },
    remote: createRemote(),
  }

  context.inject = (_deps, callback) => callback(context)
  return context
}

const checked = []

for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const dir = join(root, 'packages', entry.name)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest.dsh?.client) continue

  const exportTarget = manifest.exports?.['./client']
  const target = typeof exportTarget === 'string' ? exportTarget : exportTarget?.default
  const file = target ? join(dir, target) : join(dir, 'lib/client.js')
  const problems = []
  let documentStub

  const declared = Array.isArray(manifest.dsh.client.external) ? manifest.dsh.client.external : []
  for (const name of declared) {
    if (!HOST_REQUESTS.has(name) && !PLATFORM_REQUESTS.has(name)) {
      problems.push(`unknown dsh.client.external entry ${JSON.stringify(name)}`)
    }
  }
  const allowedRequests = new Set([...PLATFORM_REQUESTS, ...declared])

  if (!target) problems.push('exports["./client"] is missing')
  if (existsSync(join(dir, 'client')))
    problems.push('legacy client/ source directory still present')
  if (!existsSync(file)) {
    problems.push(`missing built bundle ${relative(root, file)}`)
  } else {
    const code = readFileSync(file, 'utf8')
    if (!code.startsWith('window.__ModuleLoader__.load({')) {
      problems.push('bundle does not start with the module-loader call')
    }
    if (!code.includes('data-plugin-css')) {
      problems.push('stylesheet was not inlined into the factory')
    }
    const requires = [
      ...new Set([...code.matchAll(/\brequire\("([^"]+)"\)/gu)].map((match) => match[1])),
    ]
    for (const request of requires) {
      if (!allowedRequests.has(request)) {
        problems.push(`undeclared require(${JSON.stringify(request)})`)
      }
    }

    let loaded
    documentStub = createDocument()
    try {
      const context = {
        window: {
          __ModuleLoader__: {
            load(module) {
              loaded = module
            },
          },
        },
        document: documentStub,
        require: checkRequire,
        console,
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        queueMicrotask: () => {},
        fetch: () => Promise.resolve({ ok: true, json: async () => ({}) }),
      }
      vm.runInNewContext(code, context, { filename: file })
    } catch (error) {
      problems.push(
        `factory evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (!loaded) {
      problems.push('loader never received a module')
    } else {
      if (loaded.id !== manifest.name) {
        problems.push(
          `registered id ${JSON.stringify(loaded.id)} != ${JSON.stringify(manifest.name)}`,
        )
      }
      const registrations = []
      try {
        const exports = loaded.factory(checkRequire)
        if (typeof exports.apply !== 'function') problems.push('missing apply export')
        if (!Array.isArray(exports.inject)) problems.push('missing inject export')
        if (typeof exports.apply === 'function') {
          const cleanups = []
          exports.apply(createContext(registrations, cleanups))
          for (const cleanup of cleanups) cleanup()
        }
      } catch (error) {
        problems.push(`apply failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (registrations.length === 0) problems.push('apply registered no slot component')
      for (const { options, component } of registrations) {
        try {
          const injected = options.inject ? options.inject() : {}

          renderToStaticMarkup(
            React.createElement(component, {
              t: (key) => key,
              sessionId: 'session-check',
              useProjection: () => undefined,
              useSessions: () => ({}),
              useSession: () => undefined,
              useWorkspaces: () => undefined,
              useSessionStatus: () => undefined,
              useChat: () => undefined,
              useConversation: () => undefined,
              useResource: () => undefined,
              useContextMenu: () => undefined,
              usePanelInfo: () => undefined,
              useSessionRetainInfo: () => undefined,
              useTrajectory: () => undefined,
              useRemoteAccess: () => true,
              useAccess: () => true,
              useWorkspaceAccess: () => true,
              useSessionAccess: () => true,
              inputActions: {},
              ...injected,
            }),
          )
        } catch (error) {
          problems.push(
            `render ${options.name}/${options.id} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
    }
  }

  const style = documentStub?.appended.find(
    (element) => element.attributes['data-plugin'] === manifest.name,
  )
  if (documentStub && !style) {
    problems.push('factory did not append its owned <style data-plugin> element')
  } else if (style) {
    const cssKey = style.attributes['data-plugin-css']
    if (cssKey !== `${manifest.name}/client.css`) {
      problems.push(`style owner key ${JSON.stringify(cssKey)} is not ${manifest.name}/client.css`)
    }
    if (typeof style.textContent !== 'string' || !style.textContent.includes('.dshx-root')) {
      problems.push('inline stylesheet is missing the scoped root rules')
    }
  }

  checked.push(manifest.name)
  if (problems.length > 0) failures.push([manifest.name, problems])
}

if (failures.length > 0) {
  for (const [label, problems] of failures) {
    process.stderr.write(`\n${label}\n`)
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
  }
  process.stderr.write(`\nclient bundles: ${failures.length}/${checked.length} failed\n`)
  process.exit(1)
}

process.stdout.write(`client bundles: ${checked.length} ok (${checked.join(', ')})\n`)
