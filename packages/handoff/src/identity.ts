/**
 * Stable identity shared by every module of the handoff plugin.
 *
 * @module dsh-handoff/identity
 */

/** npm package name (also the logger channel). */
export const PACKAGE_NAME = 'dsh-handoff'

/** Cordis plugin row name / exported plugin name. */
export const PLUGIN_NAME = 'handoff'

/** The slash command users type (`/handoff <task>`). */
export const COMMAND_NAME = 'handoff'

/**
 * Completion marker the briefing turn must place on the last line of the
 * brief file. The host-side watcher treats it as "the brief is finished";
 * anything earlier (partial writes, tool retries) keeps polling.
 */
export const COMPLETE_MARKER = '<!-- handoff:complete -->'

/** Default brief directory, relative to the session's workspace cwd. */
export const DEFAULT_BRIEF_DIR = '.dsh/handoff'

/** This package's browser channel prefix (same envelope as the connection RPC carriers). */
export const RPC_CHANNEL = '/dsh-handoff'
