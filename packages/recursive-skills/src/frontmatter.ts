/**
 * Frontmatter parsing for the recursive skills provider.
 *
 * The shipped filesystem provider parses `<root>/<skill>/SKILL.md` with a
 * deliberately small grammar: YAML frontmatter delimited by `---` lines,
 * required non-empty `name` (kebab-case) and `description`, optional
 * `whenToUse`, optional `metadata` object, and two invocation booleans.
 * `parseFrontmatter` / `parseSkillFile` are not exported from that package, so
 * this module reproduces the same observable contract for nested bundles.
 *
 * @module dsh-recursive-skills/frontmatter
 */
import { isSkillName, type SkillInvocationPolicy } from '@deepseek-ai/dsh-skill'
import { parse } from 'yaml'

/** One valid skill document: routing fields plus the instruction body. */
export interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly content: string
}

/** Parse outcome: a valid skill, or the reason the file must be ignored. */
export type SkillParse =
  | { readonly ok: true; readonly skill: ParsedSkill }
  | { readonly ok: false; readonly reason: string }

interface Frontmatter {
  readonly data: Record<string, unknown>
  readonly body: string
}

/**
 * Parse one `SKILL.md` text. Invalid input is reported, never thrown: a broken
 * bundle must not fail discovery for every other skill.
 * @param raw - complete file text.
 * @returns the parsed skill, or a human-readable reason it was ignored.
 */
export function parseSkillDocument(raw: string): SkillParse {
  let frontmatter: Frontmatter | undefined
  try {
    frontmatter = splitFrontmatter(raw)
  } catch (error) {
    return { ok: false, reason: `invalid YAML frontmatter: ${String(error)}` }
  }
  if (frontmatter === undefined) return { ok: false, reason: 'missing YAML frontmatter' }

  const name = stringField(frontmatter.data, 'name')
  const description = stringField(frontmatter.data, 'description')
  if (name === undefined || description === undefined) {
    return { ok: false, reason: 'frontmatter requires name and description' }
  }
  if (!isSkillName(name)) return { ok: false, reason: `invalid skill name "${name}"` }

  let invocation: SkillInvocationPolicy
  try {
    invocation = parseInvocationPolicy(frontmatter.data)
  } catch (error) {
    return { ok: false, reason: `invalid invocation frontmatter: ${String(error)}` }
  }

  const whenToUse = stringField(frontmatter.data, 'whenToUse')
  const metadata = optionalMetadata(frontmatter.data)
  return {
    ok: true,
    skill: {
      name,
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      invocation,
      ...(metadata === undefined ? {} : { metadata }),
      content: frontmatter.body.trim(),
    },
  }
}

/** Narrow a parsed YAML/JSON value to an indexable record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Split the leading `---` block and the body; undefined means no frontmatter. */
function splitFrontmatter(raw: string): Frontmatter | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined

  const start = firstLineEnd + 1
  const closing = findClosingFence(raw, start)
  if (closing === undefined) return undefined

  const parsed: unknown = parse(raw.slice(start, closing.start))
  if (!isRecord(parsed)) return undefined
  return { data: parsed, body: raw.slice(closing.bodyStart) }
}

/** Locate a `---` fence line at or after `start`. */
function findClosingFence(
  raw: string,
  start: number,
): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalMetadata(
  data: Record<string, unknown>,
): Readonly<Record<string, unknown>> | undefined {
  const value = data.metadata
  return isRecord(value) ? value : undefined
}

function parseInvocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  rejectLegacyKey(data, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyKey(data, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyKey(data, 'userInvocable', 'user-invocable')
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

function rejectLegacyKey(data: Record<string, unknown>, legacy: string, canonical: string): void {
  if (Object.hasOwn(data, legacy)) {
    throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}
