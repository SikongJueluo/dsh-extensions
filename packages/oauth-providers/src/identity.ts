/**
 * Stable package-level identities.
 *
 * This package is the home for OAuth-authenticated LLM providers: each
 * provider module under `src/providers/` registers its own LLM route,
 * settings namespace, and credential record, and shares this package's
 * browser sign-in channel. Adding a vendor is adding a provider module.
 *
 * @module dsh-oauth-providers/identity
 */

/** The npm package, profile bundle, and browser-module identity. */
export const PACKAGE_NAME = 'dsh-oauth-providers'

/** Cordis diagnostic name; matches the composition row id. */
export const PLUGIN_NAME = 'oauth-providers'

/** Browser→host RPC channel serving every provider's sign-in bridge. */
export const RPC_CHANNEL = '/dsh-oauth-providers'
