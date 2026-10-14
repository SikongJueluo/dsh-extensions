import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { assertSupportedJsonSchema, validateJsonSchemaValue, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, type Config } from '../src/index.js'
import type { ExecFile } from '../src/jj.js'

interface Fixture {
  ctx: Context
  listeners: Map<string, { fn: (...args: unknown[]) => unknown; prepend: boolean }[]>
  registered: ToolDefinition[]
  session: {
    id: string
    header: { cwd?: string }
    events: unknown[]
    appended: { type: string; data: unknown; opts: unknown }[]
    snapshotEvents(): unknown[]
    append(type: string, data: unknown, opts: unknown): unknown
  }
  agent: { id: string; session: unknown }
  storageDir: string
  tempDir: string
  jj: { changeId: string; parentChangeIds: string[]; workspaceRoot: string; fail?: string; recheckChangeId?: string }
  execCalls: { file: string; args: readonly string[]; cwd: string }[]
  events: unknown[]
  appended: { type: string; data: unknown; opts: unknown }[]
}

function makeFixture(): Fixture {
  const fixture = {} as Fixture
  fixture.listeners = new Map()
  fixture.registered = []
  fixture.execCalls = []
  fixture.events = []
  fixture.appended = []
  fixture.session = {
    id: 'sess-it',
    header: { cwd: undefined },
    events: fixture.events,
    appended: fixture.appended,
    snapshotEvents: () => [...fixture.events],
    append: (type, data, opts) => {
      fixture.appended.push({ type, data, opts })
      return undefined
    },
  }
  fixture.agent = { id: 'agent-it', session: fixture.session }
  const fakeCtx = {
    logger: { warn: () => {}, info: () => {} },
    get: () => undefined,
    on: (type: string, fn: (...args: unknown[]) => unknown, prepend = false) => {
      const list = fixture.listeners.get(type) ?? []
      list.push({ fn, prepend })
      fixture.listeners.set(type, list)
      return () => {}
    },
    tools: {
      schemas: () => [],
      register: (def: ToolDefinition) => {
        fixture.registered.push(def)
        return () => {}
      },
    },
  }
  fixture.ctx = fakeCtx as unknown as Context
  fixture.jj = { changeId: 'change-AAA', parentChangeIds: ['change-PPP'], workspaceRoot: '', recheckChangeId: undefined }
  return fixture
}

async function initFixture(fixture: Fixture, overrides: Partial<Config> = {}): Promise<void> {
  fixture.tempDir = await mkdtemp(join(tmpdir(), 'anchor-it-'))
  fixture.storageDir = join(fixture.tempDir, 'storage')
  fixture.session.header.cwd = fixture.tempDir
  fixture.jj.workspaceRoot = fixture.tempDir
  let layerReads = 0
  const fakeExec: ExecFile = async (file, args, options) => {
    fixture.execCalls.push({ file, args: [...args], cwd: options.cwd })
    if (fixture.jj.fail !== undefined) {
      throw Object.assign(new Error(fixture.jj.fail), { stderr: fixture.jj.fail })
    }
    if (args.includes('workspace')) {
      return { stdout: `${fixture.jj.workspaceRoot}\n`, stderr: '', code: 0 }
    }
    layerReads += 1
    const changeId = layerReads === 2 && fixture.jj.recheckChangeId !== undefined ? fixture.jj.recheckChangeId : fixture.jj.changeId
    return { stdout: `${changeId}\n${fixture.jj.parentChangeIds.join(' ')}\n`, stderr: '', code: 0 }
  }
  const config: Config = { storagePath: fixture.storageDir, jjTimeoutMs: 2000, resumeNotice: true, ...overrides }
  apply(fixture.ctx as Context, config, { exec: fakeExec, jjPath: 'jj-fake' })
}

const tempRoots: string[] = []
afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })))
})

function toolOf(fixture: Fixture): ToolDefinition {
  const tool = fixture.registered.find((def) => def.name === 'checkpoint_task')
  if (tool === undefined) throw new Error('checkpoint_task not registered')
  return tool
}

function execContext(fixture: Fixture) {
  return { callId: 'ck1', name: 'checkpoint_task', arguments: {}, agent: fixture.agent, signal: new AbortController().signal } as never
}

function goalEvent(id: string, revision: number): unknown {
  return {
    type: 'goal/change',
    seq: 1,
    time: 0,
    data: { kind: 'goal/change', version: 1, operation: 'edit', goal: { id, revision, objective: 'o', phase: 'active', maxGoalRounds: 5 }, roundsStarted: 1, createdAt: 0, updatedAt: 0 },
  }
}

describe('adapter: checkpoint_task through the real defineTool', () => {
  it('registers with a converted output schema inside the enforced subset', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    tempRoots.push(fixture.tempDir)
    assertSupportedJsonSchema(toolOf(fixture).output.schema)
  })

  it('execute saves the anchor and returns a value that validates against the output schema', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    tempRoots.push(fixture.tempDir)
    fixture.events.push(goalEvent('g1', 4))
    const tool = toolOf(fixture)
    const result = await tool.execute(
      { phase: 'implement', ownedFiles: ['src/a.ts'], verification: 'vitest green', goalId: 'g1', goalRevision: 4 },
      execContext(fixture),
    ) as Record<string, unknown>
    expect(validateJsonSchemaValue(tool.output.schema, result, 'value')).toEqual([])
    expect(result).toMatchObject({ saved: true, goalId: 'g1', goalRevision: 4, goalProof: 'fold-agrees', parentChangeIds: ['change-PPP'] })
    expect('note' in result).toBe(false)
    const anchorRaw = await readFile(join(fixture.storageDir, 'anchors', 'sess-it.json'), 'utf8')
    expect(JSON.parse(anchorRaw)).toMatchObject({ sessionId: 'sess-it', phase: 'implement', vcs: { changeId: 'change-AAA', parentChangeIds: ['change-PPP'] }, goal: { goalId: 'g1', revision: 4, phase: 'active', proof: 'fold-agrees' } })
    const blocks = tool.output.render({ phase: 'implement' } as never, result as never)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    for (const call of fixture.execCalls) {
      expect(call.args).toContain('--ignore-working-copy')
      expect(call.args).toContain('--no-pager')
    }
  })

  it('records an unverified goal when no durable goal events exist', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    tempRoots.push(fixture.tempDir)
    const tool = toolOf(fixture)
    const result = await tool.execute({ phase: 'p', goalId: 'g9', goalRevision: 1 }, execContext(fixture)) as Record<string, unknown>
    expect(validateJsonSchemaValue(tool.output.schema, result, 'value')).toEqual([])
    expect(result).toMatchObject({ goalProof: 'args-only-unverified' })
    expect(typeof result.note).toBe('string')
  })

  it('rejects a CAS mismatch against the durable fold', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    tempRoots.push(fixture.tempDir)
    fixture.events.push(goalEvent('g1', 7))
    await expect(toolOf(fixture).execute({ phase: 'p', goalId: 'g1', goalRevision: 6 }, execContext(fixture)))
      .rejects.toThrow('goal revision mismatch')
  })

  it('fails loudly on a non-jj root without writing an anchor', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    tempRoots.push(fixture.tempDir)
    fixture.jj.fail = 'Error: Not a jj repo (no .jj directory)'
    await expect(toolOf(fixture).execute({ phase: 'p' }, execContext(fixture)))
      .rejects.toThrow('not a jj repository')
  })

  it('rejects a checkpoint when the working layer drifted mid-read (jj new between the reads)', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    tempRoots.push(fixture.tempDir)
    fixture.jj.recheckChangeId = 'change-ZZZ'
    await expect(toolOf(fixture).execute({ phase: 'p' }, execContext(fixture)))
      .rejects.toThrow('moved while the facts were being read')
  })

  it('resume notice reports drift after the working change moved', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    tempRoots.push(fixture.tempDir)
    await toolOf(fixture).execute({ phase: 'implement' }, execContext(fixture))
    fixture.jj.changeId = 'change-ZZZ'
    fixture.jj.parentChangeIds = ['change-QQQ']
    const created = fixture.listeners.get('agent/created')?.[0]
    if (created === undefined) throw new Error('no agent/created listener')
    await created.fn({ agent: fixture.agent, source: 'resume' })
    const notice = fixture.appended.find((entry) => entry.type === 'user/message')
    expect(notice).toBeDefined()
    const data = notice?.data as { content?: { type?: string; text?: string }[] }
    const text = data.content?.[0]?.text ?? ''
    expect(text).toContain('MISMATCH')
    expect(text).toContain('phase "implement"')
  })

  it('delivers the resume notice as a plain surface append, never a deferred inject', async () => {
    const fixture = makeFixture()
    await initFixture(fixture)
    tempRoots.push(fixture.tempDir)
    await toolOf(fixture).execute({ phase: 'implement' }, execContext(fixture))
    const created = fixture.listeners.get('agent/created')?.[0]
    if (created === undefined) throw new Error('no agent/created listener')
    await created.fn({ agent: fixture.agent, source: 'resume' })
    // `agent/created` fires while the agent is idle, so there is no tool-call
    // batch to split and the append is safe (contrast the guard's hint).
    const notice = fixture.appended.find((entry) => entry.type === 'user/message')
    expect(notice?.opts).toMatchObject({ surfaceOp: 'append' })
  })

  it('skips the resume notice when resumeNotice is disabled, and on a repeat creation', async () => {
    const fixture = makeFixture()
    await initFixture(fixture, { resumeNotice: false })
    tempRoots.push(fixture.tempDir)
    await toolOf(fixture).execute({ phase: 'implement' }, execContext(fixture))
    const created = fixture.listeners.get('agent/created')?.[0]
    if (created === undefined) throw new Error('no agent/created listener')
    await created.fn({ agent: fixture.agent, source: 'resume' })
    expect(fixture.appended.filter((entry) => entry.type === 'user/message')).toEqual([])

    const second = makeFixture()
    await initFixture(second)
    tempRoots.push(second.tempDir)
    await toolOf(second).execute({ phase: 'implement' }, execContext(second))
    const listener = second.listeners.get('agent/created')?.[0]
    if (listener === undefined) throw new Error('no agent/created listener')
    await listener.fn({ agent: second.agent, source: 'resume' })
    await listener.fn({ agent: second.agent, source: 'resume' })
    expect(second.appended.filter((entry) => entry.type === 'user/message')).toHaveLength(1)
  })
})
