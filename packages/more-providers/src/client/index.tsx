// Client half of dsh-more-providers: surfaces the host half's last config
// state. Provider rows register at startup only, so an invalid file stays
// reported until dsh restarts — the notice says so explicitly.
import { ConfigStatusToast, type DshClientContext } from '@dsh-extensions/ui'
import './styles.css'

function apply(ctx: DshClientContext) {
  const connection = ctx.get('connection')
  function ProvidersConfigNotice() {
    return (
      <ConfigStatusToast statusUrl="/dsh-more-providers/config-status" connection={connection} />
    )
  }
  ctx.slots.inject('shell.overlay', () => {
    ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-more-providers-config-notice', order: 90 },
      ProvidersConfigNotice,
    )
  })
}

export { apply }
export const inject = ['slots']
