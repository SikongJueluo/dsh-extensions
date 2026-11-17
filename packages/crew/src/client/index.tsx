import { ConfigStatusToast, type DshClientContext } from '@dsh-extensions/ui'
import './styles.css'

function apply(ctx: DshClientContext) {
  const connection = ctx.get('connection')
  const logger = ctx.logger('dsh-crew')
  function CrewConfigNotice() {
    return (
      <ConfigStatusToast
        statusUrl="/dsh-crew/config-status"
        connection={connection}
        logger={logger}
      />
    )
  }
  ctx.slots.inject('shell.overlay', () => {
    ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-crew-config-notice', order: 90 },
      CrewConfigNotice,
    )
  })
}

export { apply }
export const inject = ['slots']
