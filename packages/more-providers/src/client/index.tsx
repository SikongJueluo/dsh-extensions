import { ConfigStatusToast, type DshClientContext } from '@dsh-extensions/ui'
import { registerProvidersSettings } from './providers'
import './styles.css'

function apply(ctx: DshClientContext) {
  const connection = ctx.get('connection')
  const logger = ctx.logger('dsh-more-providers')
  function ProvidersConfigNotice() {
    return (
      <ConfigStatusToast
        statusUrl="/dsh-more-providers/config-status"
        connection={connection}
        logger={logger}
      />
    )
  }
  ctx.slots.inject('shell.overlay', () => {
    ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-more-providers-config-notice', order: 90 },
      ProvidersConfigNotice,
    )
  })
  registerProvidersSettings(ctx)
}

export { apply }
export const inject = ['slots', 'locale', 'remote', 'remote.llm']
