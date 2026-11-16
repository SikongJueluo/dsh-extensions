import { describe, expect, it } from 'vitest'
import { parseSkillDocument } from '../src/frontmatter.js'

function parse(frontmatter: string, body = '# Body\n') {
  return parseSkillDocument(`---\n${frontmatter}\n---\n${body}`)
}

describe('parseSkillDocument', () => {
  it('parses the minimal routing fields and trims the body', () => {
    const result = parse('name: pdf\ndescription: Work with PDF files', '\n# PDF\n\n')
    expect(result).toMatchObject({
      ok: true,
      skill: {
        name: 'pdf',
        description: 'Work with PDF files',
        invocation: { modelInvocable: true, userInvocable: true },
        content: '# PDF',
      },
    })
  })

  it('keeps whenToUse and metadata objects', () => {
    const result = parse(
      [
        'name: pdf',
        'description: Work with PDF files',
        'whenToUse: When a PDF must be read or produced',
        'metadata:',
        '  owner: docs',
        '  tags: [pdf, office]',
      ].join('\n'),
    )
    expect(result).toMatchObject({
      ok: true,
      skill: {
        whenToUse: 'When a PDF must be read or produced',
        metadata: { owner: 'docs', tags: ['pdf', 'office'] },
      },
    })
  })

  it('maps both invocation booleans and accepts their loose spellings', () => {
    expect(parse('name: a\ndescription: A\ndisable-model-invocation: true')).toMatchObject({
      ok: true,
      skill: { invocation: { modelInvocable: false, userInvocable: true } },
    })
    expect(parse('name: a\ndescription: A\nuser-invocable: off')).toMatchObject({
      ok: true,
      skill: { invocation: { modelInvocable: true, userInvocable: false } },
    })
    expect(parse('name: a\ndescription: A\ndisable-model-invocation: 0')).toMatchObject({
      ok: true,
      skill: { invocation: { modelInvocable: true, userInvocable: true } },
    })
    expect(parse('name: a\ndescription: A\ndisable-model-invocation: "yes"')).toMatchObject({
      ok: true,
      skill: { invocation: { modelInvocable: false, userInvocable: true } },
    })
  })

  it('rejects legacy invocation keys instead of silently ignoring them', () => {
    for (const field of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
      const result = parse(`name: a\ndescription: A\n${field}: true`)
      expect(result.ok).toBe(false)
      const unsupported: unknown = expect.stringContaining('unsupported')
      expect(result).toMatchObject({ reason: unsupported })
    }
  })

  it('rejects invalid names, missing fields, bad YAML, and absent frontmatter', () => {
    const invalidYaml: unknown = expect.stringContaining('invalid YAML frontmatter')
    expect(parse('name: Bad_Name\ndescription: A')).toMatchObject({
      ok: false,
      reason: 'invalid skill name "Bad_Name"',
    })
    expect(parse('name: pdf')).toMatchObject({
      ok: false,
      reason: 'frontmatter requires name and description',
    })
    expect(parse('name: [unclosed')).toMatchObject({
      ok: false,
      reason: invalidYaml,
    })
    expect(parseSkillDocument('# no frontmatter')).toMatchObject({
      ok: false,
      reason: 'missing YAML frontmatter',
    })
    expect(parseSkillDocument('---\nname: pdf\ndescription: A\n# unterminated')).toMatchObject({
      ok: false,
      reason: 'missing YAML frontmatter',
    })
  })

  it('ignores a non-object metadata value', () => {
    expect(parse('name: a\ndescription: A\nmetadata: not-an-object')).toMatchObject({
      ok: true,
      skill: {},
    })
    expect(parse('name: a\ndescription: A\nmetadata: not-an-object')).not.toHaveProperty(
      'skill.metadata',
    )
  })

  it('accepts CRLF frontmatter fences', () => {
    const raw = '---\r\nname: pdf\r\ndescription: A\r\n---\r\n# PDF\r\n'
    expect(parseSkillDocument(raw)).toMatchObject({
      ok: true,
      skill: { name: 'pdf', content: '# PDF' },
    })
  })
})
