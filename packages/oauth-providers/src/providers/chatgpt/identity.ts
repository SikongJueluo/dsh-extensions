/**
 * Stable identities of the ChatGPT provider module.
 *
 * The LLM route is `chatgpt` — `openai` / `openai-codex` are claimed by the
 * stock pi-ai adapter's dormant directory, and this route names what it
 * serves: the ChatGPT subscription. The credential record lives under this
 * package's scope, one id per provider.
 *
 * @module dsh-oauth-providers/providers/chatgpt/identity
 */

/** The LLM provider route this module registers. */
export const PROVIDER = 'chatgpt'

/**
 * DSH settings namespace holding this provider's editable configuration:
 * the owning plugin row's entry id (0.2: namespace ≡ profile entry id). The
 * live value is resolved from the registering fiber's entry, falling back to
 * the bundle patch's stock row id.
 */
export const SETTINGS_NAMESPACE = 'oauth-providers'

/** Credential-record id: the sign-in under this package's scope. */
export const CREDENTIAL_ID = 'chatgpt'

/** User-facing provider name for selectors and cards. */
export const DISPLAY_NAME = 'ChatGPT (OpenAI)'
