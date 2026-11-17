/**
 * dsh-session-write-access - persistent, user-approved extra writable directories for one session family.
 * @module dsh-session-write-access
 */
export { default, ForkBusyError, SessionWriteAccessPolicy } from './service.js'
export type { WriteScopeView } from './service.js'
export { Config as ConfigSchema, PACKAGE_ROOT, resolveProtectedRoots } from './config.js'
export type { Config } from './config.js'
export { ACCESS_DOMAIN, SESSION_WRITE_ACCESS_DOMAIN } from './domain.js'
export type { ForkRecord, GroupRecord, GrantRecord, MemberRecord, RequestRecord } from './domain.js'
export { AccessError, AccessStore, covers } from './access.js'
export type {
  AccessErrorCode,
  AccessStatus,
  AddResult,
  DecisionResult,
  GrantView,
  RemoveResult,
  RequestResult,
  SessionFacts,
  SessionLookup,
} from './access.js'
export {
  InvalidWriteRootError,
  ProtectedWriteRootError,
  admitWriteRoot,
  canonicalDirectory,
  expandPath,
  findProtectedOverlap,
  mergeWritableRoots,
  overlaps,
  physicalDirectory,
} from './paths.js'
export { RPC_CHANNEL } from './channel.js'
export { applyGroupPolicy } from './policy.js'
