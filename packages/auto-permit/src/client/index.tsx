import { useEffect, useState } from 'react'
import {
  Alert,
  Field,
  Root,
  Select,
  Spinner,
  Switch,
  type DshClientContext,
  type SelectGroup,
} from '@dsh-extensions/ui'
import { isRecord, isUnknownArray } from '../record.js'
import './styles.css'

const NS = 'auto-permit'

interface ModelEntry {
  id: string
  name: string
}

interface CatalogModel extends ModelEntry {
  reasoning?: { efforts?: ModelEntry[] }
}

interface CatalogGroup {
  id: string
  name: string
  models: CatalogModel[]
}

interface Catalog {
  groups?: CatalogGroup[]
}

interface Entry {
  enabled: boolean
  provider: string
  model: string
  reasoningEffort?: string
  revision?: number
}

type SettingsPatch = Record<string, string | boolean | null>

type ReadResult = { ok: true; value: Entry } | { ok: false; message: string }

interface CatalogResult {
  ok: boolean
  value?: Catalog
}

interface Operations {
  read(): Promise<ReadResult>
  write(patch: SettingsPatch, revision?: number): Promise<ReadResult>
  modelCatalog(): Promise<CatalogResult>
}

function catalogModel(
  catalog: Catalog | null,
  provider: string,
  model: string,
): CatalogModel | null {
  for (const group of catalog?.groups ?? []) {
    if (group.id !== provider) continue
    for (const entry of group.models) if (entry.id === model) return entry
  }
  return null
}

type RemoteMethod = (...args: unknown[]) => unknown

function isRemoteMethod(value: unknown): value is RemoteMethod {
  return typeof value === 'function'
}

function remoteMethod(source: unknown, service: string, name: string): RemoteMethod | undefined {
  const remote = isRecord(source) ? source : undefined
  const object = remote === undefined ? undefined : remote[service]
  const method = isRecord(object) ? object[name] : undefined
  return isRemoteMethod(method) ? method : undefined
}

function entryOf(view: unknown): Entry {
  const record = isRecord(view) ? view : undefined
  const value = record !== undefined && isRecord(record.value) ? record.value : {}
  return {
    enabled: value.enabled !== false,
    provider: typeof value.provider === 'string' ? value.provider : '',
    model: typeof value.model === 'string' ? value.model : '',
    reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : undefined,
    revision: typeof record?.revision === 'number' ? record.revision : undefined,
  }
}

function AutoPermitSection({ operations }: { operations: Operations }) {
  const [entry, setEntry] = useState<Entry | null>(null)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [managed, setManaged] = useState(false)

  useEffect(() => {
    let alive = true
    operations
      .read()
      .then((result) => {
        if (!alive) return undefined
        if (result.ok) setEntry(result.value)
        else setError(result.message || 'Failed to read the configuration.')
        return undefined
      })
      .catch(() => {
        if (alive) setError('Failed to read the configuration.')
      })
    operations
      .modelCatalog()
      .then((result) => {
        if (!alive) return undefined
        if (result.ok && result.value) setCatalog(result.value)
        else setError('Failed to load the model catalog.')
        return undefined
      })
      .catch(() => {
        if (alive) setError('Failed to load the model catalog.')
      })
    return () => {
      alive = false
    }
  }, [operations])

  function write(patch: SettingsPatch) {
    setBusy(true)
    setError(null)
    setManaged(false)
    operations
      .write(patch, entry?.revision)
      .then((result) => {
        setBusy(false)
        if (result.ok) {
          setEntry(result.value)
          return undefined
        }
        if (result.message.includes('overridden by a home patch')) setManaged(true)
        else setError(result.message)
        return undefined
      })
      .catch(() => {
        setBusy(false)
        setError('Save failed.')
      })
  }

  if (entry === null) {
    return (
      <Root className="dshx:p-4">
        <div className="dshx:flex dshx:items-center dshx:gap-2 dshx:text-xs dshx:text-fg-muted">
          <Spinner />
          Loading…
        </div>
      </Root>
    )
  }

  const picked = catalogModel(catalog, entry.provider, entry.model)
  const efforts = picked?.reasoning?.efforts ?? []
  const effortValid = efforts.some((effort) => effort.id === entry.reasoningEffort)
  const selectedModel =
    entry.provider && entry.model ? `${entry.provider}/${entry.model}` : '__none__'

  const modelGroups: SelectGroup[] = [
    {
      id: 'status',
      label: 'Status',
      options: [{ value: '__none__', label: 'Not configured — auto-permit stays inactive' }],
    },
    ...(catalog?.groups ?? []).map((group) => ({
      id: group.id,
      label: group.name,
      options: group.models.map((model) => ({
        value: `${group.id}/${model.id}`,
        label: model.name !== model.id ? `${model.name} (${model.id})` : model.id,
      })),
    })),
  ]

  function pickModel(value: string) {
    if (value === '__none__') {
      write({ provider: '', model: '' })
      return
    }
    const slash = value.indexOf('/')
    const provider = value.slice(0, slash)
    const model = value.slice(slash + 1)

    if (entry?.reasoningEffort) {
      const next = catalogModel(catalog, provider, model)
      const kept = next?.reasoning?.efforts?.some((effort) => effort.id === entry.reasoningEffort)
      if (!kept) {
        write({ provider, model, reasoningEffort: null })
        return
      }
    }
    write({ provider, model })
  }

  return (
    <Root className="dshx:flex dshx:max-w-[720px] dshx:flex-col dshx:gap-4 dshx:p-4">
      <p className="dshx:text-xs dshx:leading-[20px] dshx:text-fg-muted">
        Before a bash sandbox escalation reaches the approval dialog, a judge model checks it
        against this session&apos;s user prompts and previously approved commands; anything it
        cannot ground falls back to the human dialog. Irreversible shapes (rm -rf ~, git clean -xfd,
        reset --hard, push --force, sudo, curl|sh…) always go to the human. The judge model must be
        picked explicitly — it never follows the session model.
      </p>

      <div className="dshx:flex dshx:items-center dshx:justify-between dshx:gap-3">
        <span className="dshx:text-xs dshx:font-medium dshx:text-fg">Enabled</span>
        <Switch
          checked={entry.enabled}
          disabled={busy}
          aria-label="Enabled"
          onCheckedChange={() => write({ enabled: !entry.enabled })}
        />
      </div>

      <Field label="Judge model" className="dshx:max-w-[420px]">
        <Select
          value={selectedModel}
          onValueChange={pickModel}
          groups={modelGroups}
          disabled={busy || catalog === null}
          placeholder={catalog === null ? 'Loading models…' : 'Not configured'}
          aria-label="Judge model"
        />
      </Field>

      {efforts.length > 0 ? (
        <Field label="Reasoning effort" className="dshx:max-w-[420px]">
          <Select
            value={effortValid && entry.reasoningEffort ? entry.reasoningEffort : '__default__'}
            onValueChange={(value) =>
              write(
                value === '__default__' ? { reasoningEffort: null } : { reasoningEffort: value },
              )
            }
            disabled={busy}
            aria-label="Reasoning effort"
            options={[
              { value: '__default__', label: 'Default' },
              ...efforts.map((effort) => ({
                value: effort.id,
                label: effort.name !== effort.id ? `${effort.name} (${effort.id})` : effort.id,
              })),
            ]}
          />
        </Field>
      ) : null}

      {managed ? (
        <Alert variant="info">
          This row is contributed by a home patch / command-line overlay (e.g. your NixOS plugin
          declaration). Edit its config there and rebuild; the Web form cannot override the defining
          layer.
        </Alert>
      ) : null}
      {error !== null ? <Alert variant="error">{error}</Alert> : null}

      {busy ? (
        <div className="dshx:flex dshx:items-center dshx:gap-2 dshx:text-2xs dshx:text-fg-muted">
          <Spinner />
          Saving…
        </div>
      ) : null}
    </Root>
  )
}

function apply(ctx: DshClientContext) {
  const operations: Operations = {
    read(): Promise<ReadResult> {
      const describe = remoteMethod(ctx.remote, 'settings', 'describe')
      if (describe === undefined) {
        return Promise.resolve({ ok: false as const, message: 'settings describe failed' })
      }
      return Promise.resolve(describe()).then((envelope: unknown) => {
        if (!isRecord(envelope) || envelope.ok !== true) {
          return { ok: false as const, message: 'settings describe failed' }
        }
        const value = isRecord(envelope.value) ? envelope.value : undefined
        const namespaces =
          value !== undefined && isUnknownArray(value.namespaces) ? value.namespaces : []
        const namespace = namespaces.find((candidate) => isRecord(candidate) && candidate.ns === NS)
        if (namespace === undefined) {
          return { ok: false as const, message: 'auto-permit row is not mounted' }
        }
        return { ok: true as const, value: entryOf(namespace) }
      })
    },
    write(patch, revision) {
      const ops = Object.keys(patch).map((key) => {
        return patch[key] === null
          ? { op: 'unset' as const, path: [key] }
          : { op: 'set' as const, path: [key], value: patch[key] }
      })
      const mutate = remoteMethod(ctx.remote, 'settings', 'mutate')
      if (mutate === undefined) {
        return Promise.resolve({ ok: false as const, message: 'Save failed.' })
      }
      return Promise.resolve(mutate(NS, ops, revision)).then((envelope: unknown) => {
        if (!isRecord(envelope) || envelope.ok !== true) {
          return {
            ok: false as const,
            message:
              isRecord(envelope) &&
              isRecord(envelope.error) &&
              typeof envelope.error.message === 'string'
                ? envelope.error.message
                : 'Save failed.',
          }
        }
        return { ok: true as const, value: entryOf(envelope.value) }
      })
    },
    modelCatalog(): Promise<CatalogResult> {
      const modelCatalog = remoteMethod(ctx.remote, 'session', 'modelCatalog')
      if (modelCatalog === undefined) {
        return Promise.resolve({ ok: false, value: undefined })
      }
      return Promise.resolve(modelCatalog()).then((envelope: unknown) => {
        if (!isRecord(envelope)) return { ok: false, value: undefined }
        return {
          ok: envelope.ok === true,
          value: isRecord(envelope.value) ? envelope.value : undefined,
        }
      })
    },
  }

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'auto-permit',
        order: 15,
        label: () => 'Auto Permit',
        inject: () => ({ operations }),
      },
      AutoPermitSection,
    )
  })
}

export { apply }
export const inject = ['slots', 'remote', 'remote.session', 'remote.settings']
