/**
 * dsh-hello — the reference example plugin for this repository.
 *
 * It exercises the complete authoring surface in one small module:
 *
 * - `name` and `inject` plugin metadata: the framework waits for the `tools`
 *   service before calling `apply`, so `ctx.tools` is ready to use.
 * - A Schemastery `Config` schema with defaults: Cordis validates the row's
 *   `config` against it while loading, fills defaults, and hot-replaces the
 *   plugin when the configuration changes.
 * - One model-facing tool registered through `ctx.tools.register(defineTool(...))`.
 *   Anything registered through `ctx` cleans itself up on unload.
 * - A named logger via `ctx.logger(name)`.
 *
 * Load it (development) with a `--patch` overlay pointing at the built entry,
 * or install the bundle into a profile with `dsh plugin --profile <name> add`.
 * See the repository README for both loops.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'hello'

export const inject = ['tools']

export interface Config {
  /** Word the greet tool prefixes the name with. */
  greeting: string
  /** Render the greeting in upper case. */
  uppercase: boolean
}

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  uppercase: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) {
  // Structured logging: lands in the harness log buffer (surfaced by the Web
  // UI's log views). Note that CLI surfaces print only error/warn by default,
  // so an info line will NOT appear in a headless terminal.
  const log = ctx.logger('dsh-hello')
  log.info('loaded (greeting=%s, uppercase=%s)', config.greeting, config.uppercase)

  // Terminal proof-of-life while developing (the official tutorial's check):
  // remove this line once your plugin does something observable.
  console.log(`[dsh-hello] loaded (greeting=${config.greeting})`)

  ctx.tools.register(
    defineTool({
      name: 'greet',
      description: 'Greet someone by name.',
      parameters: {
        name: { type: 'string', required: true, description: 'The name to greet.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        let text = `${config.greeting}, ${args.name}!`
        if (config.uppercase) text = text.toUpperCase()
        return text
      },
    }),
  )
}
