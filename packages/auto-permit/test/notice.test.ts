/**
 * Notice rendering: the collapsed row stays one line, while the expanded body
 * carries the stable defer category and the evidence references.
 *
 * @module dsh-auto-permit/notice.test
 */
import { describe, expect, it } from 'vitest'
import { buildNoticeMessage } from '../src/notice.js'

function textOf(message: ReturnType<typeof buildNoticeMessage>): string {
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
}

describe('judge notices', () => {
  it('renders an allow reason', () => {
    const message = buildNoticeMessage('allowed', 'podman build .', 'project build under rule 3')
    expect(textOf(message)).toContain('judge: project build under rule 3')
    expect('summary' in message.source && message.source.summary).toContain('allowed')
  })

  it('renders the defer category, reason, and evidence references', () => {
    const message = buildNoticeMessage('deferred', 'bash scripts/build.sh', 'script calls an unread helper', {
      category: 'policy',
      evidence: ['scripts/build.sh:10-20', 'scripts/helper.sh:1-5'],
    })
    const text = textOf(message)
    expect(text).toContain('judge (policy): script calls an unread helper')
    expect(text).toContain('evidence: scripts/build.sh:10-20, scripts/helper.sh:1-5')
  })

  it('keeps a category visible even when the model gave no reason', () => {
    const message = buildNoticeMessage('deferred', 'podman build .', undefined, { category: 'timeout' })
    expect(textOf(message)).toContain('judge (timeout): no reason recorded')
  })

  it('does not add an empty category for an explicit policy defer without a reason', () => {
    const message = buildNoticeMessage('deferred', 'podman build .', undefined, { category: 'policy' })
    expect(textOf(message)).not.toContain('policy')
  })
})
