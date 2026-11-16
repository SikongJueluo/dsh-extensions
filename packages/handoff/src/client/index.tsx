/* oxlint-disable jsx-a11y/no-autofocus, react/set-state-in-effect -- autoFocus is a desktop-only enhancement (off under pointer: coarse);
   the effect mirrors external data into local UI state and deriving it would change render timing */
// Client half of dsh-handoff: the configuration card shown when /handoff asks
// which model, preset, and workspace the fresh session should use. TypeScript
// TSX on the shared @dsh-extensions/ui components, built by Vite into the DSH
// client factory.
//
// Registers one `shell.overlay` entry — the frame-wide floating layer, so the
// card is a real modal — and talks to the host half over this package's
// channel (`/dsh-handoff`): poll for a pending pick, submit the verdict or
// cancel. The catalog comes from the same Client Remote the /model popup
// reads, so provider groups, model display names, and efforts match.
import { useEffect, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  Input,
  Root,
  Switch,
  cn,
  type DshClientContext,
} from '@dsh-extensions/ui'
import './styles.css'

const RPC_BASE = '/dsh-handoff'
const POLL_MS = 1500

const INHERIT_LABEL = '继承当前会话'
const DEFAULT_LABEL = '全局默认'
const ORIGIN_LABEL = '原工作区'
// A selector row that already is the card's effective value.
const CURRENT_BADGE = '当前'
// Flag-decided fields display with this badge and no 更改 button, so the
// summary can never contradict what will actually run.
const FLAG_BADGE = '命令指定'
const REVIEW_LABEL = '自动审核'

// Touch-primary devices (phones): hover feedback and autofocus are
// desktop enhancements; on them a tap-fired mouseenter sticks and the
// autofocus keyboard covers the list, so both stay off.
const COARSE =
  typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches

// --- wire shapes (the host publishes no browser-half types; narrowed here) ---

interface EffortEntry {
  id: string
  name: string
  description?: string
}

interface ModelEntry {
  id: string
  name: string
  description?: string
  reasoning?: { efforts?: EffortEntry[]; defaultEffort?: string }
}

interface CatalogFailure {
  id: string
  name?: string
  message: string
}

interface CatalogGroup {
  id: string
  name: string
  models: ModelEntry[]
}

interface Catalog {
  groups?: CatalogGroup[]
  failures?: CatalogFailure[]
}

interface RouteWire {
  provider: string
  model: string
  reasoningEffort?: string
}

interface WorkspaceWire {
  id: string
  title: string
  path: string
  missing?: boolean
}

interface PresetWire {
  id: string
  name?: string
  description?: string
  /** Non-empty when the preset cannot compose a session right now. */
  broken?: string
}

type PresetChoice = { kind: 'inherit' } | { kind: 'preset'; id: string }

interface PresetRequestWire {
  /** The origin session's live preset; absent when it runs none. */
  inherited?: string
  options: PresetWire[]
  /** The preset the card preselects (a retry's pick, else inherit). */
  default: PresetChoice
  /** Why that default cannot mount as-is; the card must ask for a reselect. */
  defaultIssue?: string
}

type ModelChoice =
  | { kind: 'inherit' }
  | { kind: 'default' }
  | { kind: 'model'; provider: string; model: string; reasoningEffort?: string }

interface ChoiceRequestWire {
  id: string
  task: string
  inherited?: RouteWire
  fallback?: RouteWire
  /** The model the card preselects; `defaultChoiceIssue` marks it unrunnable. */
  defaultChoice?: ModelChoice
  defaultChoiceIssue?: string
  /** Preset selection block (present = the composition registers presets). */
  preset?: PresetRequestWire
  /** The origin session's workspace (or bare cwd when ungrouped). */
  origin?: WorkspaceWire
  /** Registered workspaces other than the origin's; absent/empty = no step. */
  workspaces?: WorkspaceWire[]
  /** Whether the browser must run the workspace step before answering. */
  pickWorkspace?: boolean
  /** The model came from `--model`; the picker starts at the workspace step. */
  modelFixed?: boolean
  /** The flag-fixed route, shown in the confirmation summary (`modelFixed` only). */
  fixedModel?: RouteWire
  /** The `--workspace` flag's resolved target, shown as fixed in the summary. */
  fixedWorkspace?: WorkspaceWire
  /** Retry default: the previous attempt's workspace pick. */
  previous?: { workspaceId?: string }
  /** Auto-review block: toggle defaults, or a flag-decided read-only verdict. */
  review?: { defaultRounds: number; enabled?: boolean; fixed?: boolean }
}

interface RpcResult {
  ok?: boolean
  message?: string
}

interface PendingResult {
  requests?: ChoiceRequestWire[]
}

interface CatalogEnvelope {
  ok: boolean
  value?: Catalog
  error?: { message?: string }
}

interface Operations {
  pending(): Promise<PendingResult>
  choose(requestId: string, choice: Record<string, unknown>): Promise<RpcResult>
  cancel(requestId: string): Promise<RpcResult>
  modelCatalog(): Promise<CatalogEnvelope>
}

let rpcSeq = 0

function callRpc<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
  rpcSeq += 1
  return fetch(`${RPC_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `handoff-${String(rpcSeq)}`,
      method: endpoint,
      payload: payload || {},
    }),
  })
    .then((response) => response.json() as Promise<{ result?: T }>)
    .then((body) => {
      if (body && body.result) return body.result
      return { ok: false, message: 'unexpected channel response' } as T
    })
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(err)
}

// --- shared row classes (theme tokens only; no style tables) ---

const GROUP_TITLE_CLASS =
  'dshx:px-2 dshx:pb-1 dshx:pt-2.5 dshx:text-[11px] dshx:leading-4 dshx:tracking-[0.04em] dshx:text-fg-muted dshx:uppercase'
const EMPTY_CLASS = 'dshx:px-2.5 dshx:py-3 dshx:text-[13px] dshx:text-fg-muted'
const DIVIDER_CLASS = 'dshx:mx-2 dshx:my-2 dshx:h-px dshx:bg-border'
const FIELD_LABEL_CLASS =
  'dshx:w-[72px] dshx:shrink-0 dshx:text-[11px] dshx:uppercase dshx:leading-4 dshx:tracking-[0.04em] dshx:text-fg-muted'
const FIELD_VALUE_CLASS =
  'dshx:flex dshx:min-w-0 dshx:flex-1 dshx:items-center dshx:gap-1.5 dshx:text-[13px] dshx:text-fg'

/** One clickable entry, optionally carrying a small badge beside its label.
 * `muted` renders an unselectable row (a broken preset, a workspace whose
 * directory is gone) without hiding the reason from the operator. Hover
 * feedback stays a desktop enhancement (pointer: coarse retreat). */
interface EntryProps {
  label: string
  description?: string
  badge?: string
  busy: boolean
  muted?: boolean
  onPick: () => void
}

function Entry({ label, description, badge, busy, muted, onPick }: EntryProps) {
  const [hovered, setHovered] = useState(false)
  return (
    <button
      type="button"
      disabled={busy || muted === true}
      onMouseEnter={
        COARSE
          ? undefined
          : () => {
              setHovered(true)
            }
      }
      onMouseLeave={
        COARSE
          ? undefined
          : () => {
              setHovered(false)
            }
      }
      onClick={onPick}
      className={cn(
        'dshx:flex dshx:min-h-11 dshx:w-full dshx:cursor-pointer dshx:flex-col dshx:items-stretch',
        'dshx:justify-center dshx:gap-0.5 dshx:rounded-xl dshx:border dshx:border-transparent',
        'dshx:px-2.5 dshx:py-2 dshx:text-left dshx:text-fg dshx:outline-none',
        !COARSE && hovered ? 'dshx:bg-surface-2' : null,
        muted ? 'dshx:cursor-default dshx:opacity-50' : null,
      )}
    >
      <span className="dshx:flex dshx:min-w-0 dshx:items-center dshx:gap-1.5">
        <span className="dshx:text-sm dshx:font-medium dshx:leading-[22px]">{label}</span>
        {badge ? <Badge variant="brand">{badge}</Badge> : null}
      </span>
      {description ? (
        <span className="dshx:truncate dshx:text-xs dshx:leading-[18px] dshx:text-fg-muted">
          {description}
        </span>
      ) : null}
    </button>
  )
}

/** One summary row: label, value (may carry a badge), optional 更改. */
interface FieldRowProps {
  label: string
  value: string
  badge?: string
  changeable?: boolean
  busy?: boolean
  onOpen?: () => void
}

function FieldRow({ label, value, badge, changeable, busy, onOpen }: FieldRowProps) {
  return (
    <div className="dshx:flex dshx:min-h-11 dshx:items-center dshx:gap-2.5 dshx:px-2 dshx:py-1.5">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <span className={FIELD_VALUE_CLASS}>
        {badge ? (
          <Badge variant="brand" className="dshx:shrink-0">
            {badge}
          </Badge>
        ) : null}
        <span className="dshx:truncate">{value}</span>
      </span>
      {changeable ? (
        <Button variant="secondary" disabled={busy} onClick={onOpen} className="dshx:shrink-0">
          更改
        </Button>
      ) : null}
    </div>
  )
}

type Section = 'model' | 'effort' | 'preset' | 'workspace'

interface PickerProps {
  request: ChoiceRequestWire
  operations: Operations
  onSettled: () => void
}

/** The configuration card, rendered only while a pick is pending.
 * ONE card, not a wizard: every field shows its effective value (the retry
 * pick, else the remembered handoff default, else inherit), 更改 expands
 * that one field's selector in place, and only the fixed 开始交接 button
 * submits. Model and preset are independent fields. */
function Picker({ request, operations, onSettled }: PickerProps) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The field whose selector is expanded: null = the summary card.
  const [section, setSection] = useState<Section | null>(null)
  // The model the operator picked in this card (null = the host default).
  const [choice, setChoice] = useState<ModelChoice | null>(null)
  // The preset the operator picked in this card (null = the host default).
  const [presetPick, setPresetPick] = useState<PresetChoice | null>(null)
  // The selected workspace id (null = the retry pick, else origin).
  const [wsPick, setWsPick] = useState<string | null>(null)
  // Auto-review verdict: offered toggle or flag-fixed display.
  const reviewOffer = request.review ?? null
  const reviewFixed = reviewOffer?.fixed === true
  const [review, setReview] = useState({
    enabled: reviewOffer?.enabled === true,
    rounds: reviewOffer ? reviewOffer.defaultRounds : 5,
  })

  const modelFixed = request.modelFixed === true
  const fixedModel = request.fixedModel ?? null
  const fixedWorkspace = request.fixedWorkspace ?? null
  const previousWorkspace = request.previous?.workspaceId
  const presetBlock = request.preset ?? null

  const effectiveChoice = choice ?? request.defaultChoice ?? { kind: 'inherit' }
  const effectivePreset = presetPick ??
    (presetBlock ? presetBlock.default : null) ?? { kind: 'inherit' }

  // Escape collapses an expanded selector first and only cancels at the
  // summary card; a backdrop press or the close button cancels from any view.
  // Intercepting Escape here (capture phase) keeps Base UI from closing the
  // dialog while a selector is open.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || section === null) return
      event.preventDefault()
      event.stopPropagation()
      setSection(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
    }
  }, [section])

  useEffect(() => {
    setQuery('')
    setError(null)
    let alive = true
    // `ctx.remote.*` answers with the connection result envelope
    // ({ok:true, value} | {ok:false, error}); the catalog is inside `value`.
    operations
      .modelCatalog()
      .then((result) => {
        if (!alive) return
        if (result && result.ok === true) {
          setCatalog(result.value ?? null)
          return
        }
        const failure = result && result.error ? result.error : null
        setError(failure && failure.message ? failure.message : '模型目录加载失败')
      })
      .catch((err: unknown) => {
        if (alive) setError(errorMessage(err))
      })
    return () => {
      alive = false
    }
  }, [request.id, operations])

  function needsWorkspace(): boolean {
    return request.pickWorkspace === true && (request.workspaces?.length ?? 0) > 0
  }

  /** Expand one field's selector with a fresh search, so a query typed
   * for another field never filters the next one. */
  function openSection(name: Section) {
    setQuery('')
    setSection(name)
  }

  /** The ONE effective workspace verdict, shared by the summary row AND
   * the submit payload: this pick → the retry's previous pick (when it is
   * still in the roster) → origin. Display and payload must never
   * disagree — a card that shows "Other" must not submit "origin". */
  function effectiveWorkspace(): string {
    if (wsPick !== null) return wsPick
    if (
      previousWorkspace !== undefined &&
      (previousWorkspace === 'origin' ||
        (request.workspaces ?? []).some((w) => w.id === previousWorkspace))
    ) {
      return previousWorkspace
    }
    return 'origin'
  }

  /** The catalog's entry for one route, when it advertises it. */
  function catalogModel(provider: string, model: string): ModelEntry | null {
    for (const group of catalog?.groups ?? []) {
      if (group.id !== provider) continue
      for (const entry of group.models) {
        if (entry.id === model) return entry
      }
    }
    return null
  }

  /** The catalog's display name for one reasoning effort, else the raw id. */
  function effortText(provider: string, model: string, effortId: string): string {
    const entry = catalogModel(provider, model)
    for (const effort of entry?.reasoning?.efforts ?? []) {
      if (effort.id === effortId) return effort.name
    }
    return effortId
  }

  /** Name a route as the full catalog labels it, effort included. */
  function routeText(route: RouteWire | null | undefined, fallbackText: string): string {
    if (!route) return fallbackText
    const entry = catalogModel(route.provider, route.model)
    const parts: string[] = []
    if (entry) parts.push(entry.name)
    parts.push(`${route.provider}/${route.model}`)
    if (route.reasoningEffort) {
      parts.push(`强度 ${effortText(route.provider, route.model, route.reasoningEffort)}`)
    }
    return parts.join(' · ')
  }

  /** The preset row matching an id, when the registry still lists it. */
  function presetOption(id: string): PresetWire | null {
    for (const option of presetBlock?.options ?? []) {
      if (option.id === id) return option
    }
    return null
  }

  function presetName(id: string): string {
    const row = presetOption(id)
    return row?.name ? row.name : id
  }

  /** The route the effort section edits, when its model advertises efforts. */
  function effortRoute(): RouteWire | null {
    if (modelFixed) return fixedModel
    if (effectiveChoice.kind === 'model') return effectiveChoice
    if (effectiveChoice.kind === 'inherit') return request.inherited ?? null
    return request.fallback ?? null
  }

  /** Adopt an effort for the current model choice. Inherit/default picks
   * become explicit model choices: an inherited route with a changed
   * effort is exactly that route with the effort spelled out. */
  function pickEffort(effortId: string) {
    const route = effortRoute()
    if (!route) {
      setSection(null)
      return
    }
    setChoice({
      kind: 'model',
      provider: route.provider,
      model: route.model,
      reasoningEffort: effortId,
    })
    setSection(null)
  }

  // A host-resolved default that cannot run as-is demands a reselect; once
  // the operator picks a replacement the issue clears.
  const modelIssue =
    !modelFixed && choice === null && request.defaultChoiceIssue ? request.defaultChoiceIssue : null
  const selectedPresetRow =
    effectivePreset.kind === 'preset' ? presetOption(effectivePreset.id) : null
  const presetIssue =
    presetBlock && presetPick === null && presetBlock.defaultIssue ? presetBlock.defaultIssue : null
  const issueText = [modelIssue, presetIssue].filter(Boolean).join('；') || null

  /** Send the final verdict to the host: model choice, preset, workspace, review. */
  function finalize() {
    if (busy) return
    if (issueText !== null) {
      setError(issueText)
      return
    }
    setBusy(true)
    const payload: Record<string, unknown> = modelFixed
      ? { kind: 'inherit' }
      : { ...effectiveChoice }
    if (needsWorkspace()) payload.workspace = effectiveWorkspace()
    if (presetBlock) payload.preset = effectivePreset
    if (reviewOffer) payload.review = { enabled: review.enabled, rounds: review.rounds }
    operations
      .choose(request.id, payload)
      .then((result) => {
        if (result && result.ok) {
          onSettled()
          return
        }
        setBusy(false)
        setError(result && result.message ? result.message : '选择提交失败')
      })
      .catch((err: unknown) => {
        setBusy(false)
        setError(errorMessage(err))
      })
  }

  function cancel() {
    if (busy) return
    setBusy(true)
    operations.cancel(request.id).then(onSettled, () => {
      onSettled()
    })
  }

  function handleDialogClose() {
    cancel()
  }

  // ── summary card values ─────────────────────────────────────────────────
  const modelValue = modelFixed
    ? routeText(fixedModel, '由 --model 指定')
    : effectiveChoice.kind === 'model'
      ? routeText(effectiveChoice, `${effectiveChoice.provider}/${effectiveChoice.model}`)
      : effectiveChoice.kind === 'default'
        ? routeText(request.fallback, '部署默认模型')
        : routeText(request.inherited, '沿用本会话的模型与强度')

  const effortRouteCard = effortRoute()
  const effortEntryCard = effortRouteCard
    ? catalogModel(effortRouteCard.provider, effortRouteCard.model)
    : null
  const hasEfforts = !!(
    effortEntryCard?.reasoning?.efforts && effortEntryCard.reasoning.efforts.length > 0
  )
  const effortValue =
    effortRouteCard && effortRouteCard.reasoningEffort
      ? `强度 ${effortText(
          effortRouteCard.provider,
          effortRouteCard.model,
          effortRouteCard.reasoningEffort,
        )}`
      : '模型默认强度'

  let presetValue: string | null = null
  if (presetBlock) {
    if (effectivePreset.kind === 'preset') {
      presetValue =
        presetName(effectivePreset.id) +
        (selectedPresetRow === null || selectedPresetRow.broken ? '（不可用）' : '')
    } else if (!presetBlock.inherited) {
      presetValue = '继承当前（无预设）'
    } else {
      const inheritedPresetRow = presetOption(presetBlock.inherited)
      presetValue = `继承当前 · ${presetName(
        presetBlock.inherited,
      )}${inheritedPresetRow === null || inheritedPresetRow.broken ? '（不可用）' : ''}`
    }
  }

  let wsValue: string
  let wsChangeable: boolean
  if (fixedWorkspace) {
    wsValue = `${fixedWorkspace.title}（${fixedWorkspace.path}）`
    wsChangeable = false
  } else if (needsWorkspace()) {
    const effectiveCard = effectiveWorkspace()
    const pickedCard = (request.workspaces ?? []).find((w) => w.id === effectiveCard)
    wsValue = pickedCard
      ? `${pickedCard.title}（${pickedCard.path}）`
      : `原工作区（${request.origin ? request.origin.path : ''}）`
    wsChangeable = true
  } else {
    wsValue = `原工作区（${request.origin ? request.origin.path : ''}）`
    wsChangeable = false
  }
  const showWorkspace = fixedWorkspace !== null || needsWorkspace()

  /** The auto-review row: a toggle when offered, a read-only verdict when
   * a flag decided it. The round budget is fixed at 5 unless a flag or a
   * retry recorded another one, and is always shown as the actual number. */
  const reviewRow =
    reviewOffer === null ? null : (
      <label
        key="review"
        htmlFor={reviewFixed ? undefined : 'dsh-handoff-review-toggle'}
        className={cn(
          'dshx:flex dshx:min-h-11 dshx:items-center dshx:gap-2.5 dshx:px-2 dshx:py-1.5',
          reviewFixed ? 'dshx:cursor-default' : 'dshx:cursor-pointer',
        )}
      >
        <span className={FIELD_LABEL_CLASS}>{REVIEW_LABEL}</span>
        <span className={FIELD_VALUE_CLASS}>
          {reviewFixed ? (
            <Badge variant="brand" className="dshx:shrink-0">
              {FLAG_BADGE}
            </Badge>
          ) : null}
          {review.enabled ? `最多 ${review.rounds} 轮` : '关闭'}
        </span>
        {reviewFixed ? null : (
          <Switch
            id="dsh-handoff-review-toggle"
            checked={review.enabled}
            onCheckedChange={(checked) => setReview({ enabled: checked, rounds: review.rounds })}
            className="dshx:shrink-0"
          />
        )}
      </label>
    )

  function summaryBody() {
    return (
      <div className="dshx:divide-y dshx:divide-border">
        <FieldRow
          label="模型"
          value={modelValue}
          badge={modelFixed ? FLAG_BADGE : undefined}
          changeable={!modelFixed}
          busy={busy}
          onOpen={() => openSection('model')}
        />
        {hasEfforts ? (
          <FieldRow
            label="思考强度"
            value={effortValue}
            changeable={!modelFixed}
            busy={busy}
            onOpen={() => openSection('effort')}
          />
        ) : null}
        {presetValue !== null ? (
          <FieldRow
            label="Preset"
            value={presetValue}
            changeable
            busy={busy}
            onOpen={() => openSection('preset')}
          />
        ) : null}
        {showWorkspace ? (
          <FieldRow
            label="工作区"
            value={wsValue}
            badge={fixedWorkspace ? FLAG_BADGE : undefined}
            changeable={wsChangeable}
            busy={busy}
            onOpen={() => openSection('workspace')}
          />
        ) : null}
        {reviewRow}
      </div>
    )
  }

  // ── expanded selectors (one field at a time, inside the same card) ──────
  function searchBox(placeholder: string) {
    return (
      <div className="dshx:px-2.5 dshx:pb-2 dshx:pt-1">
        <Input
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          autoFocus={!COARSE}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
    )
  }

  function modelBody() {
    const needle = query.trim().toLowerCase()
    const groups: CatalogGroup[] = []
    for (const group of catalog?.groups ?? []) {
      const kept = group.models.filter((model) => {
        const haystack =
          `${model.name} ${model.id} ${model.description ?? ''} ${group.name}`.toLowerCase()
        return needle.length === 0 || haystack.includes(needle)
      })
      if (kept.length > 0) groups.push({ id: group.id, name: group.name, models: kept })
    }
    // Providers whose catalog lookup failed are reported, never silently absent.
    const failures = (catalog?.failures ?? []).filter((failure) => {
      if (needle.length === 0) return true
      return `${failure.name} ${failure.id} ${failure.message}`.toLowerCase().includes(needle)
    })

    const isCurrentModel = (
      kind: 'inherit' | 'default' | 'model',
      provider?: string,
      model?: string,
    ): boolean => {
      if (effectiveChoice.kind !== kind) return false
      return (
        kind !== 'model' ||
        (effectiveChoice.kind === 'model' &&
          effectiveChoice.provider === provider &&
          effectiveChoice.model === model)
      )
    }

    return (
      <div className="dshx:flex dshx:flex-col">
        {searchBox('搜索模型 / 厂商…')}
        <Entry
          label={INHERIT_LABEL}
          description={routeText(request.inherited, '沿用本会话的模型与强度')}
          badge={isCurrentModel('inherit') ? CURRENT_BADGE : undefined}
          busy={busy}
          onPick={() => {
            setChoice({ kind: 'inherit' })
            setSection(null)
          }}
        />
        <Entry
          label={DEFAULT_LABEL}
          description={routeText(request.fallback, '部署默认模型')}
          badge={isCurrentModel('default') ? CURRENT_BADGE : undefined}
          busy={busy}
          onPick={() => {
            setChoice({ kind: 'default' })
            setSection(null)
          }}
        />
        <div className={DIVIDER_CLASS} />
        {catalog === null && error === null ? (
          <div className={EMPTY_CLASS}>正在加载模型目录…</div>
        ) : groups.length === 0 && failures.length === 0 ? (
          <div className={EMPTY_CLASS}>
            {needle.length > 0 ? '没有匹配的模型' : '没有可用的模型'}
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <div key={`g:${group.id}`}>
                <div className={GROUP_TITLE_CLASS}>{group.name}</div>
                {group.models.map((model) => {
                  const description: string[] = []
                  if (model.name !== model.id) description.push(model.id)
                  if (model.description) description.push(model.description)
                  if (model.reasoning?.defaultEffort) {
                    let defaultName: string = model.reasoning.defaultEffort
                    for (const effort of model.reasoning.efforts ?? []) {
                      if (effort.id === model.reasoning.defaultEffort) {
                        defaultName = effort.name
                        break
                      }
                    }
                    description.push(`默认强度 ${defaultName}`)
                  }
                  return (
                    <Entry
                      key={`m:${group.id}/${model.id}`}
                      label={model.name}
                      description={description.join(' · ') || undefined}
                      badge={
                        isCurrentModel('model', group.id, model.id) ? CURRENT_BADGE : undefined
                      }
                      busy={busy}
                      onPick={() => {
                        // A model without efforts commits directly; one with
                        // efforts keeps its default until 更改 强度.
                        setChoice({ kind: 'model', provider: group.id, model: model.id })
                        setSection(null)
                      }}
                    />
                  )
                })}
              </div>
            ))}
            {failures.length > 0 ? (
              <div>
                <div className={GROUP_TITLE_CLASS}>不可用</div>
                {failures.map((failure) => (
                  <div
                    key={`f:${failure.id}`}
                    className="dshx:flex dshx:flex-col dshx:gap-0.5 dshx:px-2.5 dshx:py-2"
                  >
                    <span className="dshx:text-sm dshx:font-medium dshx:leading-[22px]">
                      {failure.name || failure.id}
                    </span>
                    <span className="dshx:truncate dshx:text-xs dshx:leading-[18px] dshx:text-fg-muted">
                      {failure.message}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    )
  }

  function effortBody() {
    const routeNow = effortRoute()
    const entryNow = routeNow ? catalogModel(routeNow.provider, routeNow.model) : null
    const efforts = entryNow?.reasoning?.efforts ?? []
    const currentEffort = routeNow?.reasoningEffort
    return (
      <div className="dshx:flex dshx:flex-col">
        {efforts.map((effort) => {
          const marker =
            effort.id === currentEffort
              ? CURRENT_BADGE
              : effort.id === entryNow?.reasoning?.defaultEffort
                ? '默认'
                : undefined
          return (
            <Entry
              key={`e:${effort.id}`}
              label={effort.name}
              description={effort.description || undefined}
              badge={marker}
              busy={busy}
              onPick={() => pickEffort(effort.id)}
            />
          )
        })}
      </div>
    )
  }

  function presetBody() {
    const options = presetBlock?.options ?? []
    const inherited = presetBlock?.inherited
    const inheritedRow = inherited ? presetOption(inherited) : null
    const inheritedUsable = !inherited || (inheritedRow !== null && !inheritedRow.broken)
    return (
      <div className="dshx:flex dshx:flex-col">
        <Entry
          label="继承当前"
          description={
            inherited
              ? inheritedRow
                ? (inheritedRow.name ? inheritedRow.name : inherited) +
                  (inheritedRow.broken ? ` · 不可用：${inheritedRow.broken}` : ' · 原会话当前预设')
                : `${inherited} · 已不在注册表中`
              : '原会话没有挂载预设'
          }
          badge={effectivePreset.kind === 'inherit' ? CURRENT_BADGE : undefined}
          muted={!inheritedUsable}
          busy={busy}
          onPick={() => {
            setPresetPick({ kind: 'inherit' })
            setSection(null)
          }}
        />
        <div className={DIVIDER_CLASS} />
        {options.length === 0 ? (
          <div className={EMPTY_CLASS}>没有其他已注册的预设</div>
        ) : (
          options.map((option) => (
            <Entry
              key={`p:${option.id}`}
              label={option.name || option.id}
              description={
                option.broken ? `不可用：${option.broken}` : option.description || option.id
              }
              badge={
                effectivePreset.kind === 'preset' && effectivePreset.id === option.id
                  ? CURRENT_BADGE
                  : undefined
              }
              muted={option.broken !== undefined}
              busy={busy}
              onPick={() => {
                if (option.broken === undefined) {
                  setPresetPick({ kind: 'preset', id: option.id })
                  setSection(null)
                }
              }}
            />
          ))
        )}
      </div>
    )
  }

  function workspaceBody() {
    const wsList = request.workspaces ?? []
    const wsNeedle = query.trim().toLowerCase()
    const wsFiltered = wsList.filter((w) => {
      return wsNeedle.length === 0 || `${w.title} ${w.path}`.toLowerCase().includes(wsNeedle)
    })
    const wsTitleCounts: Record<string, number> = {}
    for (const w of wsList) {
      wsTitleCounts[w.title] = (wsTitleCounts[w.title] ?? 0) + 1
    }
    const effectiveWs = effectiveWorkspace()
    return (
      <div className="dshx:flex dshx:flex-col">
        {searchBox('搜索工作区 / 路径…')}
        <Entry
          label={ORIGIN_LABEL}
          badge={effectiveWs === 'origin' ? CURRENT_BADGE : undefined}
          description={request.origin ? request.origin.path : undefined}
          busy={busy}
          onPick={() => {
            setWsPick('origin')
            setSection(null)
          }}
        />
        <div className={DIVIDER_CLASS} />
        {wsFiltered.length === 0 ? (
          <div className={EMPTY_CLASS}>
            {wsNeedle.length > 0 ? '没有匹配的工作区' : '没有其他已注册的工作区'}
          </div>
        ) : (
          wsFiltered.map((w) => {
            const tail = w.path.split('/').filter(Boolean).slice(-2).join('/')
            const label = (wsTitleCounts[w.title] ?? 0) > 1 ? `${w.title} (${tail})` : w.title
            return (
              <Entry
                key={`w:${w.id}`}
                label={label}
                description={w.missing ? `${w.path} · 目录不存在` : w.path}
                muted={w.missing === true}
                badge={effectiveWs === w.id ? CURRENT_BADGE : undefined}
                busy={busy}
                onPick={() => {
                  if (w.missing !== true) {
                    setWsPick(w.id)
                    setSection(null)
                  }
                }}
              />
            )
          })
        )}
      </div>
    )
  }

  let body
  if (section === 'model') body = modelBody()
  else if (section === 'effort') body = effortBody()
  else if (section === 'preset') body = presetBody()
  else if (section === 'workspace') body = workspaceBody()
  else body = summaryBody()

  const sectionTitle =
    section === 'model'
      ? '新会话使用哪个模型？'
      : section === 'effort'
        ? '思考强度'
        : section === 'preset'
          ? '新会话使用哪个预设？'
          : section === 'workspace'
            ? '新会话开在哪个工作区？'
            : '交接任务'

  const statusLine = [issueText, error].filter(Boolean).join('；') || null

  const footer = (
    <>
      {statusLine !== null ? (
        <Alert variant="error" className="dshx:mr-auto dshx:min-w-0 dshx:max-w-full">
          {statusLine}
        </Alert>
      ) : null}
      {section === null ? (
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            取消
          </Button>
          <Button disabled={busy || issueText !== null} onClick={finalize}>
            开始交接
          </Button>
        </>
      ) : (
        <Button variant="secondary" disabled={busy} onClick={() => setSection(null)}>
          返回配置
        </Button>
      )}
    </>
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) handleDialogClose()
      }}
      title={sectionTitle}
      description={request.task}
      className="dshx:w-[min(560px,92vw)] dshx:max-h-[72vh]"
      footer={footer}
    >
      {body}
    </Dialog>
  )
}

/** Root overlay: polls the host channel and mounts the picker on demand. */
function Overlay({ operations }: { operations: Operations }) {
  const [request, setRequest] = useState<ChoiceRequestWire | null>(null)

  useEffect(() => {
    let alive = true
    function tick() {
      operations
        .pending()
        .then((result) => {
          if (!alive) return
          const list = result && result.requests ? result.requests : []
          setRequest(list.length > 0 ? (list[0] ?? null) : null)
        })
        .catch(() => {
          /* offline or channel absent: keep the previous state */
        })
    }
    tick()
    const timer = window.setInterval(tick, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [operations])

  return (
    <Root>
      {request === null ? null : (
        // One card instance per pending request: the key remounts the Picker
        // when a new pick arrives, so picker state never leaks across requests.
        <Picker
          key={request.id}
          request={request}
          operations={operations}
          onSettled={() => setRequest(null)}
        />
      )}
    </Root>
  )
}

function apply(ctx: DshClientContext) {
  const operations: Operations = {
    pending() {
      return callRpc<PendingResult>('pending', {})
    },
    choose(requestId, choice) {
      return callRpc<RpcResult>('choose', { requestId, choice })
    },
    cancel(requestId) {
      return callRpc<RpcResult>('cancel', { requestId })
    },
    modelCatalog() {
      return ctx.remote.session.modelCatalog() as Promise<CatalogEnvelope>
    },
  }
  ctx.slots.inject('shell.overlay', () => {
    return ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-handoff-picker',
        order: 50,
        inject: () => ({ operations }),
      },
      Overlay,
    )
  })
}

export { apply }
export const inject = ['slots', 'remote', 'remote.session']

/** Component handle for the browser-half test harness. */
export const __test = { Picker }
