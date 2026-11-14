/**
 * Deployment-boundary diagnostics for the browser management route.
 *
 * The route authenticates with DSH's owner cookie / API admission, which is the
 * same boundary the rest of the Web UI uses. That boundary is NOT independent
 * of the Agent process: under DSH's default same-UID bwrap sandbox, a shell can
 * read `$DSH_HOME/.credentials.yaml` (the cookie-signing secret) and can reach
 * loopback, so it can forge an owner credential. A host-side user-presence
 * capability or a separate OS user for the Host is required for an
 * Agent-proof management boundary; neither exists in 0.2.2-rc.1.
 *
 * This module reports that condition instead of silently claiming the route is
 * user-only. It only checks readability; it never reads the secret.
 *
 * @module dsh-session-write-access/security
 */
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { expandPath } from './paths.js'

/** The warning text; exported for tests and for the package README. */
export const OWNER_COOKIE_BOUNDARY_WARNING =
  'session-write-access: the browser management route uses DSH owner-cookie admission. '
  + 'The cookie-signing secret is readable by the same UID as the Agent sandbox, so a shell can forge an owner '
  + 'credential and call add/decide. This is NOT an Agent-proof authorization boundary; run the Host as a separate '
  + 'OS user or add a host user-presence gate before treating directory grants as user-only.'

/**
 * Enforce the opt-in `isolated` management-identity policy. Under the default
 * same-UID sandbox this refuses to load, which is the honest outcome until the
 * Host and Agent run as different OS users.
 * @param policy - configured management identity policy.
 * @param environment - process environment, injectable for tests.
 * @throws when `isolated` was requested but the cookie secret is readable.
 */
export function assertManagementIdentity(
  policy: 'owner-cookie' | 'isolated' | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (policy !== 'isolated') return
  const warning = ownerCookieBoundaryWarning(environment)
  if (warning !== undefined) {
    throw new Error(
      `${warning} managementIdentity=isolated refuses to load until the Host and Agent use different OS users.`,
    )
  }
}

/**
 * Report the owner-cookie boundary when the credentials file is readable.
 * @param environment - process environment, injectable for tests.
 * @returns the warning, or undefined when the credentials file is absent or unreadable.
 */
export function ownerCookieBoundaryWarning(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const credentials = join(expandPath('$DSH_HOME', environment), '.credentials.yaml')
  try {
    accessSync(credentials, constants.R_OK)
    return OWNER_COOKIE_BOUNDARY_WARNING
  } catch {
    return undefined
  }
}
