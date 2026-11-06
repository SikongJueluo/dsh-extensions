/**
 * dsh-jj-workspace — Jujutsu workspaces behind the existing worktree entry
 * points.
 *
 * The bundle replaces the two stock `worktrees` rows (tool scope and the
 * isolated Forge-panel scope) with one provider that dispatches by the nearest
 * VCS root: a jj repository gets an isolated workspace, a same-name task
 * bookmark, and a durable project-pool record; a Git-only repository is handed
 * to the stock runtime unchanged. The stock tool is replaced only to state the
 * VCS-neutral contract; the browser half adds the new-session option where the
 * stock Forge UI cannot see a checkout (non-colocated jj).
 *
 * @module dsh-jj-workspace
 */
export { default, Config } from './service.js'
export type {
  Config as JjWorkspaceConfig,
  CreatedWorkspace,
  CreateWorkspaceRequest,
  JjCreatedFields,
} from './service.js'
export {
  createJjWorkspace,
  findVcsRoot,
  isWithin,
  jjTaskRecord,
  parseTaskRecords,
  serializeTaskRecord,
  TASK_RECORD_FILE,
  taskRecordPath,
  validateWorkspaceName,
} from './jj.js'
export type {
  CreatedJjWorkspace,
  CreateJjWorkspaceRequest,
  JjCreatePhase,
  JjTaskOrigin,
  JjTaskRecord,
  JjWorkspaceHost,
  VcsPathInfo,
  VcsProbe,
  VcsRoot,
} from './jj.js'
