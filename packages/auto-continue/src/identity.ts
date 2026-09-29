/**
 * Stable identities for dsh-auto-continue.
 *
 * @module dsh-auto-continue/identity
 */

/** npm package name (the plugin's Loader entry name). */
export const PACKAGE_NAME = 'dsh-auto-continue'

/** Cordis plugin name (must match the cordis.patch.yml row's package). */
export const PLUGIN_NAME = 'dsh-auto-continue'

/** Policy key written into `llm/retry` session events (ours, not llm-retry's). */
export const RETRY_POLICY_KEY = '"auto-continue"'
