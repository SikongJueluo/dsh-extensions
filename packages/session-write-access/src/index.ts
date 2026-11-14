/**
 * dsh-session-write-access — persistent, user-approved extra writable
 * directories for one session family.
 *
 * The bundle disables the stock `sandbox-policy` row and mounts
 * {@link SessionWriteAccessPolicy} under the same `sandboxPolicy` service
 * name. That service is the single policy home every filesystem fence and
 * confined shell already reads, so one durable grant reaches both families
 * and a child cannot widen its own scope by changing cwd.
 *
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
