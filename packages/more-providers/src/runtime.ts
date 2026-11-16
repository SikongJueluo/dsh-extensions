import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'

/** Request-time host image capabilities required by every adapter constructor. */
export type ProviderImageServices = Required<
  Pick<PiAiAdapterOptions, 'resolveAttachments' | 'resolveImageAccess'>
>

/** Bind the owning context without capturing services before they are mounted. */
export function createProviderImageServices(ctx: Context): ProviderImageServices {
  return {
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(
        attachments,
        (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
        ref,
      ),
  }
}
