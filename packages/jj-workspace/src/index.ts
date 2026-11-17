/**
 * dsh-jj-workspace - Jujutsu workspaces behind the existing worktree entry points.
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
