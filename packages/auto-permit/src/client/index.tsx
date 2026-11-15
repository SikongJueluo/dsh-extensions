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

type ReadResult =
  | { ok: true; value: Entry }
  | { ok: false; message: string }

interface CatalogResult {
  ok: boolean
  value?: Catalog
}

interface Operations {
  read(): Promise<ReadResult>
  write(patch: SettingsPatch, revision?: number): Promise<ReadResult>
  modelCatalog(): Promise<CatalogResult>
}

interface SettingsNamespaceView {
  ns?: string
  value?: Record<string, unknown>
  revision?: number
}

interface DescribeEnvelope {
  ok?: boolean
  value?: { namespaces?: SettingsNamespaceView[] }
}

interface MutateEnvelope {
  ok?: boolean
  value?: SettingsNamespaceView
  error?: { message?: string }
}

/** The catalog entry of one model, or null when absent/not loaded. */
function catalogModel(catalog: Catalog | null, provider: string, model: string): CatalogModel | null {
  for (const group of catalog?.groups ?? []) {
    if (group.id !== provider) continue
    for (const entry of group.models) if (entry.id === model) return entry
  }
  return null
}

/** Project one settings namespace view into the editor's entry shape. */
function entryOf(view: { value?: Record<string, unknown>; revision?: number } | undefined): Entry {
  const value = view?.value ?? {}
  return {
    enabled: value.enabled !== false,
    provider: typeof value.provider === 'string' ? value.provider : '',
    model: typeof value.model === 'string' ? value.model : '',
    reasoningEffort:
      typeof value.reasoningEffort === 'string' ? value.reasoningEffort : undefined,
    revision: view?.revision,
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
        if (!alive) return
        if (result.ok) setEntry(result.value)
        else setError(result.message || 'Failed to read the configuration.')
      })
      .catch(() => {
        if (alive) setError('Failed to read the configuration.')
      })
    operations
      .modelCatalog()
      .then((result) => {
        if (!alive) return
        if (result.ok === true && result.value) setCatalog(result.value)
        else setError('Failed to load the model catalog.')
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
          return
        }
        if (result.message.includes('overridden by a home patch')) setManaged(true)
        else setError(result.message)
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
      label: 'Status',
      options: [
        { value: '__none__', label: 'Not configured — auto-permit stays inactive' },
      ],
    },
    ...(catalog?.groups ?? []).map((group) => ({
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
    // Switching models keeps the effort only when the new model has it.
    if (entry?.reasoningEffort) {
      const next = catalogModel(catalog, provider, model)
      const kept = next?.reasoning?.efforts?.some(
        (effort) => effort.id === entry.reasoningEffort,
      )
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
        against this session's user prompts and previously approved commands; anything it cannot
        ground falls back to the human dialog. Irreversible shapes (rm -rf ~, git clean -xfd,
        reset --hard, push --force, sudo, curl|sh…) always go to the human. The judge model must be
        picked explicitly — it never follows the session model.
      </p>

      <div className="dshx:flex dshx:items-center dshx:justify-between dshx:gap-3">
        <span className="dshx:text-xs dshx:font-medium dshx:text-fg">Enabled</span>
        <Switch
          checked={entry.enabled === true}
          disabled={busy}
          aria-label="Enabled"
          onCheckedChange={() => write({ enabled: !(entry.enabled === true) })}
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
              // A null clears the field (settings update path-op semantics).
              write(value === '__default__' ? { reasoningEffort: null } : { reasoningEffort: value })
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
          declaration). Edit its config there and rebuild; the Web form cannot override the
          defining layer.
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
    read() {
      return ctx.remote.settings.describe().then((envelope: DescribeEnvelope) => {
        if (!envelope || envelope.ok !== true) {
          return { ok: false as const, message: 'settings describe failed' }
        }
        const namespaces = envelope.value?.namespaces ?? []
        const namespace = namespaces.find((candidate) => candidate.ns === NS)
        if (!namespace) {
          return { ok: false as const, message: 'auto-permit row is not mounted' }
        }
        return { ok: true as const, value: entryOf(namespace) }
      })
    },
    write(patch, revision) {
      const ops = Object.keys(patch).map((key) => {
        // A null value means "clear this optional field" → unset path op.
        return patch[key] === null
          ? { op: 'unset' as const, path: [key] }
          : { op: 'set' as const, path: [key], value: patch[key] }
      })
      return ctx.remote.settings.mutate(NS, ops, revision).then((envelope: MutateEnvelope) => {
        if (!envelope || envelope.ok !== true) {
          return {
            ok: false as const,
            message:
              envelope?.error?.message ?? 'Save failed.',
          }
        }
        return { ok: true as const, value: entryOf(envelope.value) }
      })
    },
    modelCatalog() {
      return ctx.remote.session.modelCatalog()
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
