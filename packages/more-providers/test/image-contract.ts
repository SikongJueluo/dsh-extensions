import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import {
  PNG_DATA_URL,
  assistantMsg,
  type capturingFetch,
  collectStream,
  fixtureAttachmentStore,
  generateOptions,
  imageRef,
  registeredAdapter,
  toolResultMsg,
  wireBody,
  type Harness,
  type HarnessOptions,
} from './helpers.js'

interface ImageContract {
  provider: string
  model: string
  detail: string
  mount: (options?: Partial<HarnessOptions>) => Promise<Harness>
  capture: ReturnType<typeof capturingFetch>
}

/** The same observable image contract runs against both real plugin adapters. */
export function imageContract({ provider, model, detail, mount, capture }: ImageContract): void {
  const image: RequestMessage = {
    role: 'user',
    content: [{ type: 'image', attachment: imageRef('shared-image') }],
  }
  const text: RequestMessage = { role: 'user', content: [{ type: 'text', text: 'continue' }] }
  const stream = (harness: Harness, messages: RequestMessage[], extra?: Partial<GenerateOptions>) =>
    collectStream(
      registeredAdapter(harness.llm, provider).stream(
        generateOptions(provider, model, messages, extra),
      ),
    )

  describe(`${provider}: shared image contract through apply`, () => {
    it('sends request bytes and a handle for a user image', async () => {
      const harness = await mount()
      await stream(harness, [image])
      expect(capture.calls).toHaveLength(1)
      const body = wireBody(capture.calls[0]) as {
        model: string
        input: { role: string; content: { type: string; image_url?: string; detail?: string }[] }[]
      }
      expect(body.model).toBe(model)
      expect(body.input[0]).toMatchObject({ role: 'user' })
      expect(body.input[0]?.content).toContainEqual({
        type: 'input_image',
        image_url: PNG_DATA_URL,
        detail,
      })
      expect(JSON.stringify(body)).toContain('shared-image')
      expect(harness.attachments?.reads).toHaveLength(1)
    })

    it('sends tool-result images as structured function output', async () => {
      const harness = await mount()
      await stream(harness, [
        assistantMsg(provider, model, [
          {
            type: 'tool-call',
            id: 'call-1' as never,
            name: 'screenshot',
            arguments: '{}',
          },
        ]),
        toolResultMsg('call-1', [{ type: 'image', attachment: imageRef('tool-image') }]),
      ])
      expect(capture.calls).toHaveLength(1)
      const body = wireBody(capture.calls[0]) as {
        input: {
          type?: string
          call_id?: string
          output?: { type: string; image_url?: string }[]
        }[]
      }
      const output = body.input.find((item) => item.type === 'function_call_output')
      expect(output?.call_id).toBe('call-1')
      expect(output?.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'input_image', image_url: PNG_DATA_URL }),
        ]),
      )
    })

    it('retains history images when the latest message is text', async () => {
      const harness = await mount()
      await stream(harness, [
        image,
        assistantMsg(provider, model, [{ type: 'text', text: 'seen' }]),
        text,
      ])
      expect(capture.calls).toHaveLength(1)
      expect(JSON.stringify(wireBody(capture.calls[0]))).toContain(PNG_DATA_URL)
      expect(harness.attachments?.reads).toHaveLength(1)
    })

    it('reads a shared attachment once while sending each occurrence', async () => {
      const harness = await mount()
      await stream(harness, [image, image])
      expect(capture.calls).toHaveLength(1)
      expect(harness.attachments?.reads).toHaveLength(1)
      expect(JSON.stringify(wireBody(capture.calls[0])).split(PNG_DATA_URL)).toHaveLength(3)
    })

    it('represents offloaded images as text without reading their bytes', async () => {
      const harness = await mount()
      await stream(harness, [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              attachment: imageRef('offloaded-image'),
              offloaded: true,
            },
          ],
        },
      ])
      expect(capture.calls).toHaveLength(1)
      expect(harness.attachments?.reads).toHaveLength(0)
      const body = JSON.stringify(wireBody(capture.calls[0]))
      expect(body).toContain('offloaded-image')
      expect(body).not.toContain('input_image')
    })

    it('sends text-only requests without an attachment service', async () => {
      const harness = await mount({ attachments: false })
      await stream(harness, [text], { system: 'be brief' })
      expect(capture.calls).toHaveLength(1)
      const body = wireBody(capture.calls[0])
      expect(JSON.stringify(body)).toContain('be brief')
      expect(JSON.stringify(body)).not.toContain('input_image')
    })

    it('rejects image requests explicitly before dispatch when the service is absent', async () => {
      const harness = await mount({ attachments: false })
      const { error } = await stream(harness, [image])
      expect(error).toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
      expect(capture.calls).toHaveLength(0)
    })

    it('resolves the attachment service after it becomes available', async () => {
      const harness = await mount({ attachments: false })
      const attachments = fixtureAttachmentStore()
      harness.ctx.provide('attachments', attachments.store)
      await stream(harness, [image])
      expect(capture.calls).toHaveLength(1)
      expect(attachments.reads).toHaveLength(1)
      expect(JSON.stringify(wireBody(capture.calls[0]))).toContain(PNG_DATA_URL)
    })
  })
}
