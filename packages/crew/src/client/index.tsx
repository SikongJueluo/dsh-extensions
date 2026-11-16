// Client half of dsh-crew: surfaces the host half's current crew.yaml state.
// The host keeps the status, so a page loaded after the file broke still
// reports it; the shared viewport dedupes polls and re-announces on reconnect.
import { ConfigStatusToast, type DshClientContext } from '@dsh-extensions/ui'
import './styles.css'

function apply(ctx: DshClientContext) {
  const connection = ctx.get('connection')
  function CrewConfigNotice() {
    return <ConfigStatusToast statusUrl="/dsh-crew/config-status" connection={connection} />
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
