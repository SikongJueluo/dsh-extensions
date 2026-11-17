import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeText } from './comments/analyze.mjs'
import { suppressionRules } from './comments/suppressions.mjs'

const OXLINT_DISABLE = `oxlint${'-disable'}`
const ESLINT_DISABLE = `eslint${'-disable'}`
const FALLOW_IGNORE = `fallow${'-ignore'}`

function messages(path, source) {
  return analyzeText(path, source).diagnostics.map(({ message }) => message)
}

test('accepts compact file, type, function, and parameter documentation', () => {
  assert.deepEqual(
    messages(
      'sample.ts',
      `/** @module sample */\n/** The input contract. */\nexport interface Options { value: string }\n/** Runs the task.\n * @param value The input value.\n * @returns The normalized value.\n * @throws {RangeError} When the input is outside the supported range.\n */\nexport function run(value: string) { return value }\n`,
    ),
    [],
  )
})

test('ignores comment markers inside strings, templates, regexes, JSX text, and YAML scalars', () => {
  assert.deepEqual(
    messages(
      'sample.tsx',
      `const a = "// not a comment";\nconst b = /\\/\\*/;\nconst c = \`/* not a comment */\`;\nconst view = <div>// text</div>;\n`,
    ),
    [],
  )
  assert.deepEqual(
    messages('sample.yaml', `message: "# not a comment"\nscript: |\n  # not a comment\n`),
    [],
  )
})

test('rejects body and trailing comments but preserves recognized directives', () => {
  assert.ok(
    messages('sample.ts', `function run() { // explanation\n  return 1 // result\n}\n`).length >= 2,
  )
  const suppression = `// oxlint${'-disable-next-line no-alert -- approved'}\nwindow.alert('x')\n`
  assert.deepEqual(messages('sample.ts', suppression), [])
})

test('enforces file header and declaration limits across adjacent blocks', () => {
  assert.ok(
    messages(
      'sample.ts',
      `/** @module sample\n * first\n * second\n * third\n * fourth\n * fifth\n */\n`,
    ).some((message) => message.includes('file documentation exceeds 5')),
  )
  assert.ok(
    messages(
      'sample.ts',
      `/** @module sample */\n/** first */\n/** second */\n/** third */\n/** fourth */\nfunction run() {}\n`,
    ).some((message) => message.includes('declaration documentation exceeds 3')),
  )
})

test('validates tag names and parameter, return, and exception tag bounds', () => {
  const source = `/** @module sample */\n/**\n * @param x The input.\n * @param unknown Missing input.\n * @returns One.\n * @returns Two.\n * @throws {RangeError} First.\n * @throws {RangeError} Second.\n * @example run(1)\n */\nfunction run(x: number) {}\n`
  const result = messages('sample.ts', source)
  assert.ok(result.some((message) => message.includes('unknown parameter')))
  assert.ok(result.some((message) => message.includes('only one @returns')))
  assert.ok(result.some((message) => message.includes('duplicate @throws')))
  assert.ok(result.some((message) => message.includes('unsupported comment tag')))
})

test('supports @throws union type and inline links', () => {
  assert.deepEqual(
    messages(
      'sample.ts',
      `/** @module sample */\n/** Uses {@link run}.\n * @throws {TypeError | RangeError} When invalid.\n */\nfunction run() {}\n`,
    ),
    [],
  )
})

test('enforces header-only comments in CSS, JSONC, and YAML without reading string contents', () => {
  assert.deepEqual(
    messages('sample.css', `/* Theme variables. */\n:root { --x: "/* string */"; }\n`),
    [],
  )
  assert.ok(
    messages('sample.jsonc', `{"x": 1, /* inline */ "y": 2}`).some((message) =>
      message.includes('file-header'),
    ),
  )
  assert.deepEqual(
    messages('sample.yaml', `# Build configuration.\na: !!js process.platform === 'win32'\n`),
    [],
  )
  assert.ok(
    messages('sample.yaml', `a: 1 # inline note\n`).some((message) =>
      message.includes('file-header'),
    ),
  )
})

test('parses Python docstrings and rejects ordinary comments', () => {
  assert.deepEqual(
    messages(
      'sample.py',
      `"""Module note."""\n\ndef run(value):\n    """Run the task."""\n    return value\n`,
    ),
    [],
  )
  assert.ok(
    messages('sample.py', `# ordinary comment\ndef run():\n    return 1\n`).some((message) =>
      message.includes('only module'),
    ),
  )
  assert.ok(
    messages(
      'sample.py',
      `def run():\n    """One.\n    Two.\n    Three.\n    Four.\n    """\n    return 1\n`,
    ).some((message) => message.includes('exceeds 3')),
  )
  assert.deepEqual(
    messages(
      'sample.py',
      `def run(value):\n    """@param value The value.\n    @returns The value.\n    @throws {ValueError} When invalid.\n    """\n    return value\n`,
    ),
    [],
  )
  assert.ok(
    messages(
      'sample.py',
      `def run(value):\n    """@param missing Unknown parameter.\n    """\n    return value\n`,
    ).some((message) => message.includes('unknown parameter')),
  )
})

test('counts content lines, accepts tool directives, and enforces ASCII and word limits', () => {
  const suppression = `// oxlint${'-disable-next-line no-alert -- approved'}\nwindow.alert('x')\n`
  assert.deepEqual(messages('sample.ts', `/** */\n${suppression}`), [
    'file documentation must contain exactly one non-empty @module',
  ])
  assert.ok(
    messages('sample.ts', `/** @module sample */\n/** Cañonical. */\nfunction run() {}\n`).some(
      (message) => message.includes('ASCII only'),
    ),
  )
  const longLine = Array.from({ length: 101 }, (_, index) => `word${index}`).join(' ')
  assert.ok(
    messages('sample.ts', `/** @module sample */\n/** ${longLine} */\nfunction run() {}\n`).some(
      (message) => message.includes('exceeds 100 words'),
    ),
  )
  assert.ok(
    messages(
      'sample.ts',
      `/** @module sample */\n/**\n * First.\n *\n * Second.\n * Third.\n */\nfunction run() {}\n`,
    ).some((message) => message.includes('exceeds 3 general')),
  )
})

test('matches parameter docs on function-valued variables', () => {
  assert.deepEqual(
    messages(
      'sample.ts',
      `/** @module sample */\n/** @param value The input. */\nexport const run = (value: string) => value\n`,
    ),
    [],
  )
})

test('allows one nested parameter tag per actual parameter binding', () => {
  assert.deepEqual(
    messages(
      'sample.ts',
      `/** @module sample */\n/** @param options.retries The retries in the options object.\n */\nfunction run(options: { retries: number; signal: AbortSignal }) {}\n`,
    ),
    [],
  )
  assert.ok(
    messages(
      'sample.ts',
      `/** @module sample */\n/** @param options.retries The retries in the options object.\n * @param options.signal The signal in the options object.\n */\nfunction run(options: { retries: number; signal: AbortSignal }) {}\n`,
    ).some((message) => message.includes('duplicate @param')),
  )
})

test('fails closed for malformed or unsupported inputs', () => {
  assert.throws(() => analyzeText('sample.ts', 'const ='), /Unexpected|expected|Expected/iu)
  assert.throws(() => analyzeText('sample.md', '# prose'), /unsupported source extension/u)
})

test('checks raw whitespace and physical Python lines', () => {
  assert.ok(
    messages('sample.ts', '/**\u00A0Doc */\nfunction run() {}').some((message) =>
      message.includes('ASCII'),
    ),
  )
  assert.deepEqual(
    messages('sample.py', 'def run():\n    """One.\\nTwo.\\nThree.\\nFour."""\n    return 1\n'),
    [],
  )
  assert.ok(
    messages(
      'sample.py',
      'if True:\n    def run():\n        """One.\n        Two.\n        Three.\n        Four.\n        """\n        return 1\n',
    ).some((message) => message.includes('exceeds 3')),
  )
})

test('groups documentation across tool directives without duplicating diagnostics', () => {
  const directive = `// oxlint${'-disable-next-line no-alert -- approved'}`
  const source = `/** One. */\n/** Two. */\n${directive}\n/** Three. */\n/** Four. */\nfunction run() {}`
  assert.equal(
    messages('sample.ts', source).filter((message) => message.includes('exceeds 3')).length,
    1,
  )
})

test('validates exception descriptions and overlapping union exceptions', () => {
  assert.ok(
    messages('sample.ts', '/** @throws {Error} */\nfunction run() {}').some((message) =>
      message.includes('describe it'),
    ),
  )
  assert.ok(
    messages(
      'sample.ts',
      '/** @throws {Error | TypeError} Invalid.\n * @throws {TypeError} Invalid type. */\nfunction run() {}',
    ).some((message) => message.includes('duplicate @throws')),
  )
  assert.ok(
    messages('sample.ts', '/** @returns {string} */\nfunction run() {}').some((message) =>
      message.includes('description'),
    ),
  )
  assert.deepEqual(
    messages('sample.ts', '/** @module sample\n * File contract. */\nexport const C = class {}'),
    [],
  )
})

test('associates callable fields, object methods, and class-valued variables', () => {
  assert.deepEqual(
    messages(
      'sample.ts',
      '/** Class contract. */\nexport const C = class {\n/** @param x Input. */\nrun = (x: number) => x\n}\nconst obj = {\n/** @param x Input. */\nrun(x: number) { return x }\n}',
    ),
    [],
  )
  assert.ok(
    messages('sample.ts', 'const x = 1; /** Doc */\nfunction run() {}').some((message) =>
      message.includes('trailing'),
    ),
  )
})

test('checks flow YAML comments and JSON comments with parser syntax validation', () => {
  assert.ok(
    messages('sample.yaml', 'a: { x: 1, # note\n y: 2 }\n').some((message) =>
      message.includes('file-header'),
    ),
  )
  assert.ok(
    messages('sample.json', '{"x": 1 /* note */}').some((message) =>
      message.includes('file-header'),
    ),
  )
  assert.throws(() => analyzeText('sample.jsonc', '{'), /invalid JSONC/u)
})

test('accepts only syntactically valid tool directives', () => {
  const accepted = [
    '// @ts-ignore\nconst x = 1\n',
    '// @ts-expect-error\nconst x = 1\n',
    '// @ts-check\nconst x = 1\n',
    '// @ts-nocheck\nconst x = 1\n',
    '/// <reference types="node" />\nconst x = 1\n',
    '/// <reference path="./types.d.ts" />\nconst x = 1\n',
    '/* c8 ignore next 3 */\nconst x = 1\n',
    '/* v8 ignore next -- generated */\nconst x = 1\n',
    `// ${OXLINT_DISABLE}-next-line no-alert -- approved\nwindow.alert(1)\n`,
    `console.log(1) // ${OXLINT_DISABLE}-line no-console\n`,
    `// ${FALLOW_IGNORE}-file unused-export\nexport const x = 1\n`,
    `/* ${OXLINT_DISABLE} a/b, c/d -- reason\n * continued reason */\nconst x = 1\n`,
    `// ${ESLINT_DISABLE}-next-line react-hooks/exhaustive-deps\nconst x = 1\n`,
    `// ${FALLOW_IGNORE}-next-line unused-class-member -- reason\nclass A {}\n`,
    '// @vitest-environment jsdom\nconst x = 1\n',
    'const p = import(/* @vite-ignore */ "./x.js")\n',
  ]
  for (const source of accepted) assert.deepEqual(messages('sample.ts', source), [], source)
  const rejected = [
    '// ts-ignore arbitrary prose\nconst x = 1\n',
    '// reference types arbitrary prose\nconst x = 1\n',
    '/* c8 ignore potato */\nconst x = 1\n',
    `// ${OXLINT_DISABLE} this prose is not rules\nconst x = 1\n`,
    '// @vite-ignore arbitrary prose\nconst x = 1\n',
  ]
  for (const source of rejected) assert.ok(messages('sample.ts', source).length > 0, source)
  assert.deepEqual(messages('sample.py', '# noqa: BLE001 -- reason\nvalue = 1\n'), [])
  assert.deepEqual(messages('sample.py', 'value = 1  # type: ignore[attr-defined]\n'), [])
  assert.deepEqual(messages('sample.py', '# coding: utf-8\nvalue = 1\n'), [])
  assert.ok(messages('sample.py', '# noqa potato\nvalue = 1\n').length > 0)
})

test('rejects unsupported tags anywhere and validates tag descriptions', () => {
  assert.ok(
    messages(
      'sample.ts',
      '/** @param x Input. @example arbitrary */\nfunction run(x: number) {}\n',
    ).some((message) => message.includes('unsupported comment tag')),
  )
  assert.ok(
    messages('sample.ts', '/** Uses {@example text}. */\nfunction run() {}\n').some((message) =>
      message.includes('unsupported comment tag'),
    ),
  )
  assert.ok(
    messages(
      'sample.ts',
      '/** @module sample */\n/** @param x Input. @returns Result. */\nfunction run(x: number) {}\n',
    ).some((message) => message.includes('unsupported comment tag')),
  )
  assert.ok(
    messages('sample.ts', '/** @throws { } Invalid. */\nfunction run() {}\n').some((message) =>
      message.includes('name an exception'),
    ),
  )
  assert.ok(
    messages('sample.ts', '/** @param x - */\nfunction run(x: number) {}\n').some((message) =>
      message.includes('must describe'),
    ),
  )
  assert.ok(
    messages('sample.ts', '/** @returns - */\nfunction run() {}\n').some((message) =>
      message.includes('must have a description'),
    ),
  )
  assert.ok(
    messages('sample.css', '/* @example arbitrary */\n:root { --x: 1; }\n').some((message) =>
      message.includes('unsupported comment tag'),
    ),
  )
  assert.ok(
    messages('sample.yaml', '# @param fake\nx: 1\n').some((message) =>
      message.includes('unsupported comment tag'),
    ),
  )
  assert.ok(
    messages('sample.jsonc', '// @deprecated old\n{"x": 1}\n').some((message) =>
      message.includes('unsupported comment tag'),
    ),
  )
  assert.ok(
    messages('sample.css', '/* @vite-ignore */\n:root { --x: 1; }\n').some((message) =>
      message.includes('unsupported comment tag'),
    ),
  )
})

test('matches default parameter properties and destructured bindings', () => {
  assert.deepEqual(
    messages(
      'sample.ts',
      '/** @module sample */\nclass A {\n/** @param x Input. */\nconstructor(private readonly x = 1) {}\n}\n',
    ),
    [],
  )
  assert.deepEqual(
    messages(
      'sample.ts',
      '/** @module sample */\n/** @param value Input. */\nfunction run({ value }: { value: number }) {}\n',
    ),
    [],
  )
  assert.deepEqual(
    messages(
      'sample.ts',
      '/** @module sample */\n/** @param rest Values. */\nfunction run(...rest: string[]) {}\n',
    ),
    [],
  )
  assert.deepEqual(
    messages(
      'sample.ts',
      '/** @module sample */\n/** @param [value=1] Input. */\nfunction run(value = 1) {}\n',
    ),
    [],
  )
  assert.ok(
    messages(
      'sample.ts',
      '/** @module sample */\n/** @param first Input. @param second Other. */\nfunction run({ first, second }: { first: number; second: number }) {}\n',
    ).length > 0,
  )
})

test('composes implicit Python string literals by physical source line', () => {
  assert.deepEqual(messages('sample.py', 'def f(x):\n    "One " "contract."\n    return x\n'), [])
  assert.ok(
    messages(
      'sample.py',
      'def f(x):\n    """@param x First.""" """@param x Second."""\n    return x\n',
    ).some((message) => message.includes('unsupported comment tag')),
  )
  assert.ok(
    messages(
      'sample.py',
      'def f():\n    ("""One.\n    Two."""\n    """Three.\n    Four.""")\n    return 1\n',
    ).some((message) => message.includes('exceeds 3')),
  )
  assert.deepEqual(
    messages('sample.py', 'def f():\n    """One.\\nTwo.\\nThree.\\nFour."""\n    return 1\n'),
    [],
  )
  assert.ok(
    messages(
      'sample.py',
      'def run(value):\n    ("""@param missing Unknown.""")\n    return value\n',
    ).some((message) => message.includes('unknown parameter')),
  )
  assert.ok(
    messages(
      'sample.py',
      'def run(value):\n    ("""Uses {@example text}.""")\n    return value\n',
    ).some((message) => message.includes('unsupported comment tag')),
  )
  assert.deepEqual(
    messages('sample.py', 'def run(value):\n    ("""Run the task.""")\n    return value\n'),
    [],
  )
  assert.throws(() => analyzeText('sample.py', 'return 1\n'), /outside function/u)
  assert.throws(
    () => analyzeText('sample.py', 'def run(value, value):\n    """Doc."""\n    return value\n'),
    /duplicate argument/u,
  )
})

test('accepts declare functions, abstract methods, and overload signatures', () => {
  assert.deepEqual(
    messages(
      'sample.ts',
      '/** @module sample */\n/** @param x Input. */\nexport declare function run(x: number): void\n',
    ),
    [],
  )
  assert.deepEqual(
    messages(
      'sample.ts',
      '/** @module sample */\nexport abstract class A {\n/** @param x Input. */\nabstract run(x: number): void\n}\n',
    ),
    [],
  )
  assert.deepEqual(
    messages(
      'sample.ts',
      '/** @module sample */\n/** @param x Input. */\nexport function run(x: string): void\n/** @param x Input. */\nexport function run(x: number): void\nexport function run(x: string | number): void {}\n',
    ),
    [],
  )
})

test('merges split file headers and keeps declaration docs attached', () => {
  const directive = `// oxlint${'-disable-next-line no-alert -- approved'}`
  assert.deepEqual(
    messages('sample.ts', '/** @module sample */\n/** File contract. */\nimport x from "x"\n'),
    [],
  )
  assert.deepEqual(
    messages(
      'sample.ts',
      `/** @module sample */\n${directive}\n/** File contract. */\nimport x from "x"\n`,
    ),
    [],
  )
  assert.deepEqual(
    messages('sample.ts', '/** @module sample */\n/** File contract. */\nconst x = 1\n'),
    [],
  )
  assert.deepEqual(
    messages(
      'sample.ts',
      '/** @module sample */\n/** File contract. */\n/** Runs the task. */\nfunction run() {}\n',
    ),
    [],
  )
  assert.ok(
    messages('sample.ts', '/** @module sample */\n/** @module other */\nimport x from "x"\n').some(
      (message) => message.includes('exactly one'),
    ),
  )
  assert.ok(
    messages('sample.ts', '/** @module sample */\n/** @module */\nimport x from "x"\n').some(
      (message) => message.includes('exactly one'),
    ),
  )
  assert.ok(
    messages(
      'sample.ts',
      '/** @module sample */\n/** a */\n/** b */\n/** c */\n/** d */\n/** e */\nimport x from "x"\n',
    ).some((message) => message.includes('exceeds 5')),
  )
  assert.ok(
    messages(
      'sample.ts',
      'import x from "x"\n/** @module sample */\nexport function run() {}\n',
    ).some((message) => message.includes('only allowed in file documentation')),
  )
})

test('recognizes every suppression form without reading string fixtures as directives', () => {
  const source = [
    `const fixture = '// ${OXLINT_DISABLE}-next-line no-alert'`,
    `console.log(1) // ${OXLINT_DISABLE}-line no-console`,
    `/* ${FALLOW_IGNORE}-file unused-export */`,
    `// ${ESLINT_DISABLE}`,
    `// fallow-disable-next-line unused-file -- approved reason`,
    'export const value = 1',
  ].join('\n')
  assert.deepEqual(suppressionRules('sample.ts', source), [
    { line: 2, rule: 'no-console' },
    { line: 3, rule: 'unused-export' },
    { line: 4, rule: '*' },
    { line: 5, rule: 'unused-file' },
  ])
  assert.throws(() => suppressionRules('sample.ts', 'const ='), /Unexpected|expected|Expected/iu)
})

test('rejects documentation after code on the same physical line', () => {
  assert.ok(
    messages('sample.ts', '/** @module sample */ /** Doc. */\nfunction run() {}\n').some(
      (message) => message.includes('trailing'),
    ),
  )
})

test('limits Python coding directives and rejects unsupported enable suffixes', () => {
  assert.deepEqual(messages('sample.py', '# -*- coding: utf-8 -*-\nvalue = 1\n'), [])
  assert.deepEqual(
    messages('sample.py', '#!/usr/bin/env python3\n# coding: utf-8\nvalue = 1\n'),
    [],
  )
  assert.deepEqual(messages('sample.py', '\n# coding: utf-8\nvalue = 1\n'), [])
  assert.ok(messages('sample.py', 'def f():\n    # coding: utf-8\n    return 1\n').length > 0)
  assert.ok(messages('sample.py', 'value = 1\n# coding: utf-8\n').length > 0)
  assert.ok(messages('sample.py', 'value = 1  # coding: utf-8\n').length > 0)
  for (const directive of ['eslint-enable-line no-alert', 'oxlint-enable-next-line no-alert']) {
    assert.ok(messages('sample.ts', `// ${directive}\nconst x = 1\n`).length > 0, directive)
  }
  assert.deepEqual(messages('sample.ts', '// eslint-disable-line no-alert\nconst x = 1\n'), [])
  assert.deepEqual(messages('sample.ts', '/* eslint-enable */\nconst x = 1\n'), [])
})
