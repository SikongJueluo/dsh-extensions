/**
 * Stable identities of the ChatGPT provider module.
 *
 * The LLM route is `chatgpt`. The credential record stays under the fixed
 * pre-merge OAuth scope (`OAUTH_CREDENTIAL_SCOPE` in the root identity), so
 * grants written by the standalone bundle keep working after the merge.
 *
 * @module dsh-more-providers/providers/chatgpt/identity
 */

/** The LLM provider route this module registers. */
export const PROVIDER = 'chatgpt'

/**
 * DSH settings namespace holding this provider's editable configuration:
 * the owning plugin row's entry id (0.2: namespace ≡ profile entry id). The
 * live value is resolved from the registering fiber's entry, falling back to
 * this bundle's stock row id.
 */
export const SETTINGS_NAMESPACE = 'more-providers'

/** Credential-record id: the sign-in under the fixed OAuth scope. */
export const CREDENTIAL_ID = 'chatgpt'

/** User-facing provider name for selectors and cards. */
export const DISPLAY_NAME = 'ChatGPT (OpenAI)'
