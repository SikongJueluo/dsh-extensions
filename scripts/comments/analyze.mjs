import { spawnSync } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSync } from 'oxc-parser'
import { parse as parseCssSource } from 'postcss'
import { createScanner, parseTree, ScanError, SyntaxKind } from 'jsonc-parser'
import { Parser as YamlCstParser, parseAllDocuments } from 'yaml'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PYTHON_HELPER = fileURLToPath(new URL('./python-comments.py', import.meta.url))
const SKIP_DIRS = new Set([
  '.dsh',
  '.fallow',
  '.git',
  '.jj',
  '.pnpm-home',
  '.pnpm-run',
  '.pnpm-store',
  '.smoke-dsh-home',
  '.tmp',
  'dist',
  'lib',
  'node_modules',
  'repo',
  'storybook-static',
])
const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.jsx',
  '.json',
  '.jsonc',
  '.js',
  '.mjs',
  '.mts',
  '.py',
  '.ts',
  '.tsx',
  '.yml',
  '.yaml',
])
const SKIP_FILES = new Set(['pnpm-lock.yaml'])
const LINT_DIRECTIVE =
  /^(?:oxlint|eslint)-(?:disable(?:-next-line|-line)?|enable)(?:\s+[-\w@/]+(?:\s*,\s*[-\w@/]+)*)?(?:\s+--\s+.+)?$/u
const FALLOW_DIRECTIVE =
  /^fallow-(?:ignore(?:-next-line|-file)?|disable(?:-next-line)?|enable)(?:\s+[-\w]+(?:\s*,\s*[-\w]+)*)?(?:\s+--\s+.+)?$/u
const COVERAGE_DIRECTIVE =
  /^(?:(?:c8|v8)\s+ignore\s+(?:next(?:\s+\d+)?|start|stop|else|file)|istanbul\s+ignore\s+(?:if|else|next|file)(?:\s*:\s*\S.*)?|node:coverage\s+(?:disable|enable|ignore\s+next(?:\s+\d+)?))(?:\s+--\s+.+)?$/u
const REFERENCE_DIRECTIVE =
  /^\/\s*<reference\s+(?:path|types|lib|no-default-lib)\s*=\s*(?:"[^"]*"|'[^']*')\s*\/>\s*$/u
const TS_PRAGMA = /^@(?:ts-expect-error|ts-ignore|ts-nocheck|ts-check)\b/u
const ALLOWED_TAG = /^(module|param|returns|throws)$/u

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length
}

function diagnostic(source, offset, message) {
  return { line: lineAt(source, offset), message }
}

function contentLines(comment) {
  if (comment.type !== 'Block' || !comment.raw) {
    return comment.value.split(/\r?\n/u).map((line) => line.trim())
  }
  const lines = comment.raw.split(/\r?\n/u)
  lines[0] = lines[0].replace(/^.*?\/\*/u, '')
  if (lines.length === 1) lines[0] = lines[0].replace(/\*\/$/u, '')
  else lines[lines.length - 1] = lines.at(-1).replace(/\*\/$/u, '')
  return lines
    .map((line) => line.replace(/^\s*\* ?/u, '').trim())
    .filter(
      (line, index) =>
        !(lines.length === 1 && !line) &&
        !(index === 0 && !line && comment.raw.startsWith('/*')) &&
        !(index === lines.length - 1 && !line && comment.raw.endsWith('*/')),
    )
}

function isAsciiText(text) {
  return [...text].every((character) => {
    const code = character.codePointAt(0)
    return (
      (code >= 32 && code <= 126) || character === '\n' || character === '\r' || character === '\t'
    )
  })
}

function validateText(comment, source, diagnostics) {
  const lines = contentLines(comment)
  if (!isAsciiText(comment.raw ?? comment.value)) {
    diagnostics.push(diagnostic(source, comment.start, 'comment must contain printable ASCII only'))
  }
  for (const [index, line] of lines.entries()) {
    if (line.split(/\s+/u).filter(Boolean).length > 100) {
      diagnostics.push(
        diagnostic(source, comment.start, `comment line ${index + 1} exceeds 100 words`),
      )
    }
  }
  return lines
}

function isJsDirective(comment, source) {
  if (source.startsWith('#!', comment.start)) return true
  const text = contentLines(comment).join(' ').trim()
  if (comment.type === 'Line') {
    const afterSlashes = comment.raw.slice(2).trim()
    return (
      (comment.raw.startsWith('///') && REFERENCE_DIRECTIVE.test(afterSlashes)) ||
      TS_PRAGMA.test(text) ||
      LINT_DIRECTIVE.test(text) ||
      FALLOW_DIRECTIVE.test(text) ||
      COVERAGE_DIRECTIVE.test(text) ||
      /^@vitest-environment\s+\S+$/u.test(text) ||
      /^@vitest-environment-options\s+.+$/u.test(text) ||
      /^@vite-ignore$/u.test(text)
    )
  }
  return (
    /^@(?:ts-expect-error|ts-ignore)\b/u.test(text) ||
    LINT_DIRECTIVE.test(text) ||
    FALLOW_DIRECTIVE.test(text) ||
    COVERAGE_DIRECTIVE.test(text) ||
    /^@vite-ignore$/u.test(text)
  )
}

function codingOnPermittedLine(comment, source) {
  const lines = source.split(/\r?\n/u)
  if (!/^[ \t\f]*#/u.test(lines[comment.line - 1] ?? '')) return false
  if (comment.line === 1) return true
  if (comment.line !== 2) return false
  const firstLine = lines[0] ?? ''
  return firstLine.trim() === '' || firstLine.trimStart().startsWith('#')
}

function isPythonDirective(comment, source) {
  if (comment.line === 1 && comment.value.startsWith('!')) return true
  const text = comment.value.trim()
  const coding =
    /^-\*-\s*coding[:=]\s*[-\w.]+\s*-\*-$/u.test(text) || /^coding[:=]\s*[-\w.]+$/u.test(text)
  return (
    (coding && codingOnPermittedLine(comment, source)) ||
    /^noqa(?:\s*:\s*[A-Z]+\d+(?:\s*,\s*[A-Z]+\d+)*)?(?:\s+--\s+.+)?$/u.test(text) ||
    /^type:\s*ignore(?:\[[^\]]*\])?(?:\s+--\s+.+)?$/u.test(text) ||
    /^pyright:\s*ignore(?:\[[^\]]*\])?(?:\s+--\s+.+)?$/u.test(text) ||
    /^mypy:\s*ignore-errors(?:\s+--\s+.+)?$/u.test(text)
  )
}

function isDirective(comment, source, language) {
  if (language === 'python') return isPythonDirective(comment, source)
  if (language === 'js') return isJsDirective(comment, source)
  return false
}

function tagToken(text) {
  const withoutLinks = text.replaceAll(/\{@link\b[^}]*\}/gu, '')
  return withoutLinks.match(/(?:^|[\s{])@([A-Za-z][\w-]*)/u)?.[1] ?? null
}

function hasDescription(text) {
  const description = text.trim().replace(/^-\s*/u, '')
  return description.length > 0 && !/^-+$/u.test(description)
}

function parameterRoot(name) {
  const optional = name.match(/^\[([^\]]+)\]$/u)?.[1] ?? name
  const binding = optional
    .split('=')[0]
    .trim()
    .replace(/^\.\.\./u, '')
  return binding.match(/^([\w$]+)/u)?.[1] ?? null
}

function parseTags(lines, params, source, comment, diagnostics) {
  const general = []
  const tags = { param: [], returns: [], throws: [] }
  const claimed = new Set()
  let tagsStarted = false
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('@')) {
      if (tagsStarted && line.trim())
        diagnostics.push(
          diagnostic(source, comment.start, 'tag descriptions must stay on their tag line'),
        )
      else {
        general.push(line)
        const unsupported = tagToken(line)
        if (unsupported)
          diagnostics.push(
            diagnostic(source, comment.start, `unsupported comment tag "@${unsupported}"`),
          )
      }
      continue
    }
    const tag = line.match(/^@([A-Za-z][\w-]*)(?:\s+(.*))?$/u)
    if (!tag || !ALLOWED_TAG.test(tag[1])) {
      diagnostics.push(
        diagnostic(source, comment.start, `unsupported comment tag on line ${index + 1}`),
      )
      continue
    }
    const [, kind, value = ''] = tag
    const smuggled = tagToken(value)
    if (smuggled) {
      diagnostics.push(diagnostic(source, comment.start, `unsupported comment tag "@${smuggled}"`))
      continue
    }
    if (kind === 'module') continue
    tagsStarted = true
    if (!value.trim()) {
      diagnostics.push(diagnostic(source, comment.start, `@${kind} must have a description`))
      continue
    }
    if (kind === 'param') {
      const match = value.match(
        /^(?:\{[^}]*\}\s*)?(\[[^\]]+\]|\.{3}[\w$]+|[\w$]+(?:[.[][^\s]*)?)\s+(.+)$/u,
      )
      const root = match ? parameterRoot(match[1]) : null
      if (!root)
        diagnostics.push(
          diagnostic(source, comment.start, '@param must name a parameter and describe it'),
        )
      else if (!hasDescription(match[2]))
        diagnostics.push(diagnostic(source, comment.start, '@param must describe the parameter'))
      else {
        const indexOfParam = params.findIndex((names) => names.has(root))
        if (indexOfParam < 0)
          diagnostics.push(
            diagnostic(source, comment.start, `@param names unknown parameter "${match[1]}"`),
          )
        else if (claimed.has(indexOfParam))
          diagnostics.push(diagnostic(source, comment.start, `duplicate @param for "${root}"`))
        else {
          claimed.add(indexOfParam)
          tags.param.push(root)
        }
      }
    } else if (kind === 'returns') {
      if (!hasDescription(value.replace(/^\{[^}]*\}\s*/u, '')))
        diagnostics.push(diagnostic(source, comment.start, '@returns must have a description'))
      tags.returns.push(value)
    } else tags.throws.push(value)
  }
  if (tags.returns.length > 1)
    diagnostics.push(diagnostic(source, comment.start, 'only one @returns line is allowed'))
  const seenThrows = new Set()
  for (const value of tags.throws) {
    const match = value.match(/^(?:\{([^}]+)\}|([\w.$]+))\s+(.+)$/u)
    if (!match || !hasDescription(match[3])) {
      diagnostics.push(
        diagnostic(source, comment.start, '@throws must name an exception and describe it'),
      )
      continue
    }
    const exceptions = (match[1] ?? match[2]).split('|').map((name) => name.trim())
    if (exceptions.some((exception) => exception.length === 0)) {
      diagnostics.push(
        diagnostic(source, comment.start, '@throws must name an exception and describe it'),
      )
      continue
    }
    for (const exception of exceptions) {
      if (seenThrows.has(exception))
        diagnostics.push(diagnostic(source, comment.start, `duplicate @throws for "${exception}"`))
      seenThrows.add(exception)
    }
  }
  return { general, tags }
}

function validateDocGroup(group, target, source, diagnostics, mode = 'declaration') {
  if (
    group.some((comment) => comment.type !== 'Block' || !source.startsWith('/**', comment.start))
  ) {
    diagnostics.push(
      diagnostic(source, group[0].start, 'declaration documentation must use JSDoc block comments'),
    )
  }
  const lines = group.flatMap((comment) => validateText(comment, source, diagnostics))
  const first = group[0]
  const { general } = parseTags(lines, target.params ?? [], source, first, diagnostics)
  if (mode !== 'file' && lines.some((line) => /^@module\b/u.test(line))) {
    diagnostics.push(
      diagnostic(source, first.start, '@module is only allowed in file documentation'),
    )
  }
  if (mode === 'file') {
    const moduleTags = lines.filter((line) => /^@module\b/u.test(line))
    if (moduleTags.length !== 1 || !/^@module\s+\S/u.test(moduleTags[0])) {
      diagnostics.push(
        diagnostic(
          source,
          first.start,
          'file documentation must contain exactly one non-empty @module',
        ),
      )
    }
    for (const line of lines) {
      if (line.startsWith('@') && !/^@module\b/u.test(line)) {
        diagnostics.push(diagnostic(source, first.start, 'file documentation only allows @module'))
      }
    }
    if (lines.length > 5)
      diagnostics.push(
        diagnostic(source, first.start, 'file documentation exceeds 5 content lines'),
      )
    return
  }
  if (general.length > 3)
    diagnostics.push(
      diagnostic(source, first.start, 'declaration documentation exceeds 3 general content lines'),
    )
  if (
    target.kind !== 'function' &&
    lines.some((line) => /^@(param|returns|throws)\b/u.test(line))
  ) {
    diagnostics.push(
      diagnostic(source, first.start, 'only functions may use @param, @returns, or @throws'),
    )
  }
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'MethodDefinition',
  'TSDeclareFunction',
  'TSAbstractMethodDefinition',
  'TSMethodSignature',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
])
const TYPE_TYPES = new Set([
  'ClassDeclaration',
  'ClassExpression',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
])

function declarationKind(node) {
  if (FUNCTION_TYPES.has(node.type)) return 'function'
  if (TYPE_TYPES.has(node.type)) return 'type'
  if (node.type === 'VariableDeclarator') return declarationKind(node.init ?? {})
  if (node.type === 'PropertyDefinition' || node.type === 'Property')
    return declarationKind(node.value ?? {})
  return null
}

function bindingNames(pattern, names = new Set()) {
  if (!pattern) return names
  if (pattern.type === 'Identifier') names.add(pattern.name)
  else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties ?? [])
      bindingNames(property.type === 'RestElement' ? property.argument : property.value, names)
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements ?? []) bindingNames(element, names)
  } else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left, names)
  else if (pattern.type === 'RestElement') bindingNames(pattern.argument, names)
  else if (pattern.type === 'TSParameterProperty') bindingNames(pattern.parameter, names)
  return names
}

function parameterBindings(node) {
  const callable = node.type === 'VariableDeclarator' ? node.init : node
  return (callable?.params ?? callable?.value?.params ?? []).map((parameter) =>
    bindingNames(parameter),
  )
}

function onlyTriviaBetween(source, start, end, comments) {
  let text = source.slice(start, end)
  for (const comment of comments) {
    if (comment.start < start || comment.end > end) continue
    const from = comment.start - start
    const to = comment.end - start
    text = `${text.slice(0, from)}${text.slice(from, to).replaceAll(/[^\r\n]/gu, ' ')}${text.slice(to)}`
  }
  return /^\s*$/u.test(text)
}

function parseEcma(filePath, source, diagnostics) {
  const parsed = parseSync(filePath, source, { sourceType: 'unambiguous' })
  if (parsed.errors.length > 0)
    throw new Error(parsed.errors.map((error) => error.message).join('; '))
  const declarations = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (
      typeof value.type === 'string' &&
      Number.isInteger(value.start) &&
      Number.isInteger(value.end)
    ) {
      const exported = ['ExportNamedDeclaration', 'ExportDefaultDeclaration'].includes(value.type)
        ? value.declaration
        : null
      let candidate = exported ?? value
      let kind = declarationKind(candidate)
      if (
        !kind &&
        candidate.type === 'VariableDeclaration' &&
        candidate.declarations?.length === 1
      ) {
        const declarator = candidate.declarations[0]
        const declaratorKind = declarationKind(declarator)
        if (declaratorKind) {
          candidate = declarator
          kind = declaratorKind
        }
      }
      if (kind)
        declarations.push({
          node: candidate,
          start: value.start,
          kind,
          params: parameterBindings(candidate),
        })
      if (value.type === 'VariableDeclaration')
        for (const declarator of value.declarations ?? []) visit(declarator)
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'loc' || key === 'comments' || key === 'tokens') continue
      if (Array.isArray(child)) child.forEach((item) => visit(item))
      else if (child && typeof child === 'object') visit(child)
    }
  }
  visit(parsed.program)
  const comments = parsed.comments
    .toSorted((a, b) => a.start - b.start)
    .map((comment) =>
      Object.assign(comment, {
        raw: source.slice(comment.start, comment.end),
      }),
    )
  const used = new Set()
  const declarationGroups = new Map()
  const firstCodeStart = parsed.program.body[0]?.start ?? source.length
  const atLineStart = (comment) => {
    const prefix = source.slice(source.lastIndexOf('\n', comment.start - 1) + 1, comment.start)
    return prefix.trim() === ''
  }
  const leadingBlocks = comments.filter(
    (comment) =>
      comment.end <= firstCodeStart &&
      comment.type === 'Block' &&
      source.startsWith('/**', comment.start) &&
      atLineStart(comment) &&
      !isDirective(comment, source, 'js'),
  )
  const moduleBlocks = leadingBlocks.filter((comment) =>
    contentLines(comment).some((line) => /^@module\b/u.test(line)),
  )
  const moduleStarts = new Set(moduleBlocks)
  const lastModuleStart = moduleBlocks.at(-1)?.start ?? -1
  const firstDeclaration = declarations.find((declaration) => declaration.start === firstCodeStart)
  if (moduleBlocks.length > 0 || (leadingBlocks.length > 0 && !firstDeclaration)) {
    const headerBlocks = leadingBlocks.filter(
      (comment) =>
        moduleStarts.has(comment) || !firstDeclaration || comment.start < lastModuleStart,
    )
    for (const comment of headerBlocks) used.add(comment)
    validateDocGroup(headerBlocks, { kind: 'file', params: [] }, source, diagnostics, 'file')
  }
  for (const comment of comments) {
    if (used.has(comment)) continue
    if (isDirective(comment, source, 'js')) {
      validateText(comment, source, diagnostics)
      continue
    }
    if (!atLineStart(comment)) {
      diagnostics.push(diagnostic(source, comment.start, 'trailing documentation is not allowed'))
      continue
    }
    let target = null
    for (const declaration of declarations) {
      if (
        declaration.start < comment.end ||
        !onlyTriviaBetween(source, comment.end, declaration.start, comments)
      )
        continue
      if (!target || declaration.start < target.start) target = declaration
    }
    if (!target) {
      diagnostics.push(
        diagnostic(
          source,
          comment.start,
          'only file or declaration documentation and tool directives are allowed',
        ),
      )
      continue
    }
    const group = declarationGroups.get(target.start) ?? { target, comments: [] }
    group.comments.push(comment)
    declarationGroups.set(target.start, group)
  }
  for (const { target, comments: group } of declarationGroups.values())
    validateDocGroup(group, target, source, diagnostics)
}

function validateHeaderOnly(comments, source, diagnostics, language) {
  const ordered = comments.toSorted((a, b) => a.start - b.start)
  const group = []
  let end = 0
  for (const comment of ordered) {
    if (isDirective(comment, source, language)) {
      validateText(comment, source, diagnostics)
      continue
    }
    if (onlyTriviaBetween(source, end, comment.start, ordered)) {
      group.push(comment)
      end = comment.end
      continue
    }
    diagnostics.push(
      diagnostic(source, comment.start, 'only file-header documentation is allowed in this format'),
    )
  }
  if (group.length > 0) {
    const lines = group.flatMap((comment) => validateText(comment, source, diagnostics))
    for (const line of lines) {
      const tag = tagToken(line)
      if (tag)
        diagnostics.push(diagnostic(source, group[0].start, `unsupported comment tag "@${tag}"`))
    }
    if (lines.length > 5)
      diagnostics.push(
        diagnostic(source, group[0].start, 'file documentation exceeds 5 content lines'),
      )
  }
}

function parseCss(source, diagnostics) {
  const root = parseCssSource(source)
  const comments = []
  root.walkComments((node) => {
    const start = node.source.start.offset
    const end = node.source.end.offset
    comments.push({ type: 'Block', value: node.text, raw: source.slice(start, end), start, end })
  })
  validateHeaderOnly(comments, source, diagnostics, 'css')
}

function parseJsonc(source, diagnostics) {
  const errors = []
  parseTree(source, errors, { allowTrailingComma: true })
  if (errors.length > 0) throw new Error(`invalid JSONC at offset ${errors[0].offset}`)
  const scanner = createScanner(source, false)
  const comments = []
  for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
    if (scanner.getTokenError() !== ScanError.None)
      throw new Error(`invalid JSONC token ${scanner.getTokenError()}`)
    if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) {
      const start = scanner.getTokenOffset()
      const text = source.slice(start, start + scanner.getTokenLength())
      comments.push({
        type: text.startsWith('//') ? 'Line' : 'Block',
        value: text.startsWith('//') ? text.slice(2) : text.slice(2, -2),
        raw: text,
        start,
        end: start + text.length,
      })
    }
  }
  validateHeaderOnly(comments, source, diagnostics, 'jsonc')
}

function walkCst(tokens, comments, errors) {
  for (const token of tokens) {
    if (token.type === 'error') errors.push(token.message)
    if (token.type === 'comment') {
      const raw = token.source
      comments.push({
        type: 'Line',
        value: raw.slice(1),
        raw,
        start: token.offset,
        end: token.offset + raw.length,
      })
    }
    if (token.type === 'document') {
      walkCst(token.start ?? [], comments, errors)
      if (token.value) walkCst([token.value], comments, errors)
      walkCst(token.end ?? [], comments, errors)
    } else if (token.type === 'block-map' || token.type === 'block-seq') {
      for (const item of token.items) {
        walkCst(item.start ?? [], comments, errors)
        if ('key' in item && item.key) walkCst([item.key], comments, errors)
        if ('value' in item && item.value) walkCst([item.value], comments, errors)
        if ('sep' in item && item.sep) walkCst(item.sep, comments, errors)
      }
    } else if (token.type === 'flow-collection') {
      walkCst([token.start, ...token.end], comments, errors)
      for (const item of token.items) {
        walkCst(item.start ?? [], comments, errors)
        if (item.key) walkCst([item.key], comments, errors)
        if (item.sep) walkCst(item.sep, comments, errors)
        if (item.value) walkCst([item.value], comments, errors)
      }
    } else if ('end' in token && Array.isArray(token.end)) walkCst(token.end, comments, errors)
  }
}

function parseYaml(source, diagnostics) {
  const comments = []
  const errors = []
  walkCst([...new YamlCstParser().parse(source)], comments, errors)
  const documents = parseAllDocuments(source, {
    customTags: [
      {
        identify: (value) => typeof value === 'string',
        tag: 'tag:yaml.org,2002:js',
        resolve: (value) => value,
        stringify: String,
      },
    ],
  })
  for (const document of documents) errors.push(...document.errors.map((error) => error.message))
  if (errors.length > 0) throw new Error(errors.join('; '))
  validateHeaderOnly(comments, source, diagnostics, 'yaml')
}

function sourceLineOffset(source, line) {
  return (
    source
      .split('\n')
      .slice(0, line - 1)
      .join('\n').length + (line > 1 ? 1 : 0)
  )
}

function parsePython(filePath, source, diagnostics) {
  const result = spawnSync('python3', [PYTHON_HELPER], {
    input: JSON.stringify({ filePath, source }),
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Python AST parsing failed')
  const parsed = JSON.parse(result.stdout)
  for (const item of parsed.docstrings) {
    if (item.invalid || !Array.isArray(item.lines)) {
      diagnostics.push({ line: item.line, message: 'docstring literal could not be read' })
      continue
    }
    const lines = [...item.lines]
    if (lines[0]?.trim() === '') lines.shift()
    if (lines.at(-1)?.trim() === '') lines.pop()
    const offset = sourceLineOffset(source, item.line)
    const comment = {
      type: 'Line',
      value: lines.join('\n'),
      raw: item.raws.join('\n'),
      start: offset,
      end: offset + lines.join('\n').length,
    }
    if (item.raws.some((raw) => !isAsciiText(raw)))
      diagnostics.push({ line: item.line, message: 'docstring must contain printable ASCII only' })
    if (lines.some((line) => line.split(/\s+/u).filter(Boolean).length > 100))
      diagnostics.push({ line: item.line, message: 'docstring line exceeds 100 words' })
    const { general } = parseTags(
      lines.map((line) => line.trim()),
      item.params.map((name) => new Set([name])),
      source,
      comment,
      diagnostics,
    )
    if (general.length > (item.kind === 'module' ? 5 : 3))
      diagnostics.push({
        line: item.line,
        message: `${item.kind} docstring exceeds ${item.kind === 'module' ? 5 : 3} general content lines`,
      })
    if (
      item.kind !== 'function' &&
      lines.some((line) => /^@(param|returns|throws)\b/u.test(line.trim()))
    )
      diagnostics.push({
        line: item.line,
        message: 'only functions may use @param, @returns, or @throws',
      })
    if (lines.some((line) => /^@module\b/u.test(line.trim())))
      diagnostics.push({ line: item.line, message: 'Python docstrings do not use @module' })
  }
  for (const comment of parsed.comments) {
    const raw = `#${comment.value}`
    const offset = sourceLineOffset(source, comment.line)
    const directive = {
      type: 'Line',
      value: comment.value,
      raw,
      line: comment.line,
      start: offset,
      end: offset + raw.length,
    }
    if (!isDirective(directive, source, 'python'))
      diagnostics.push({
        line: comment.line,
        message: 'only module or declaration docstrings and tool directives are allowed',
      })
    else validateText(directive, source, diagnostics)
  }
}

export function analyzeText(filePath, source) {
  const diagnostics = []
  const extension = extname(filePath).toLowerCase()
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(extension))
    parseEcma(filePath, source, diagnostics)
  else if (extension === '.css') parseCss(source, diagnostics)
  else if (extension === '.json' || extension === '.jsonc') parseJsonc(source, diagnostics)
  else if (extension === '.yml' || extension === '.yaml') parseYaml(source, diagnostics)
  else if (extension === '.py') parsePython(filePath, source, diagnostics)
  else throw new Error(`unsupported source extension: ${extension || '(none)'}`)
  return { diagnostics }
}

async function* sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (
        SKIP_DIRS.has(entry.name) &&
        (entry.name !== 'lib' || /^packages\/[^/]+\/lib$/u.test(relative(ROOT, path)))
      )
        continue
      yield* sourceFiles(path)
    } else if (
      entry.isFile() &&
      !SKIP_FILES.has(entry.name) &&
      SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())
    )
      yield path
  }
}

export async function collectFiles(paths = []) {
  const files = []
  const inputs = paths.length > 0 ? paths : [ROOT]
  for (const input of inputs) {
    const absolute = resolve(ROOT, input)
    const info = await stat(absolute).catch((error) => {
      if (error.code === 'ENOENT') throw new Error(`path does not exist: ${input}`)
      throw error
    })
    const ext = extname(absolute).toLowerCase()
    if (info.isFile()) {
      if (!SOURCE_EXTENSIONS.has(ext)) throw new Error(`unsupported path extension: ${input}`)
      files.push(absolute)
    } else if (info.isDirectory()) {
      for await (const file of sourceFiles(absolute)) files.push(file)
    } else throw new Error(`unsupported path type: ${input}`)
  }
  return [...new Set(files)].toSorted((a, b) => a.localeCompare(b))
}
