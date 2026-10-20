/**
 * Package-wide constants and identity.
 *
 * @module dsh-triggers/identity
 */

/** npm package name. */
export const PACKAGE_NAME = 'dsh-triggers'
/** Cordis plugin name (the loader row). */
export const PLUGIN_NAME = 'triggers'
/** The model-facing structured handoff signal tool. */
export const TOOL_NAME = 'trigger_signal'
/** The host service handoff (or any spawner) consumes via `ctx.get()`. */
export const SERVICE_NAME = 'triggerBindings'
/** This package's browser channel prefix (web-server route). */
export const RPC_CHANNEL = '/dsh-triggers'
/** The storage domain holding templates, bindings, runs, and deliveries
 *  (storage-domain unit names admit no hyphens). */
export const DOMAIN_NAME = 'triggers'
/** Ids of the seeded built-in templates (stable; bodies editable, rows not deletable). */
export const BUILTIN_START_TEMPLATE = 'builtin-loop-start'
export const BUILTIN_REVIEW_TEMPLATE = 'builtin-loop-review'
export const BUILTIN_REWORK_TEMPLATE = 'builtin-loop-rework'
