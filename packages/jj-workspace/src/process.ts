/**
 * Sandboxed process plumbing for the jj workspace service.
 * @module dsh-jj-workspace/process
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS, deadline } from '@deepseek-ai/dsh-timeout'
import { isAbsolute } from 'node:path'

/** Resource limits shared with the stock worktree configuration. */
export interface ProcessConfig {
  jjCommand: string
  nodeCommand: string
  timeoutMs: number
  graceMs: number
  maxOutputBytes: number
}

const CLEAN_ENV: Record<string, string | undefined> = {
  ...Object.fromEntries(
    [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_COMMON_DIR',
      'GIT_INDEX_FILE',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_CONFIG',
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_COUNT',
      'GIT_CEILING_DIRECTORIES',
      'GIT_PREFIX',
      'GIT_SHALLOW_FILE',
      'GIT_GRAFT_FILE',
      'GIT_REPLACE_REF_BASE',
      'GIT_ATTR_SOURCE',
    ].map((key) => [key, undefined]),
  ),
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
  CLICOLOR: '0',
}

const PREPARE_DIRECTORY = `
import fs from 'node:fs/promises';
import path from 'node:path';
async function main() {
  const [root, destination] = process.argv.slice(1);
  await fs.mkdir(path.dirname(root), { recursive: true });
  let created = false;
  try {
    await fs.mkdir(root);
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST' || !(await fs.stat(root)).isDirectory()) throw error;
  }
  if (created) await fs.writeFile(path.join(root, '.gitignore'), '*\\n', { flag: 'wx' });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.mkdir(destination);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
`

/** Run one executable under the policy and await its whole process range. */
async function runCommand(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  cwd: string,
  argv: readonly string[],
  signal: AbortSignal | undefined,
  env: Record<string, string | undefined> = {},
): Promise<string> {
  const timeout = deadline(signal, config.timeoutMs, 'JJ_WORKSPACE_TIMEOUT')
  try {
    timeout.signal.throwIfAborted()
    const [executable, ...rest] = argv
    if (executable === undefined) {
      throw new Error('workspace command argv must start with an executable')
    }
    const command = [
      await ctx.subprocess.resolveExecutable(executable, undefined, timeout.signal),
      ...rest,
    ]
    const wrapped =
      policy.mode === 'danger-full-access'
        ? command
        : (await ctx.sandbox.confine(command, { ...policy, mode: policy.mode }, timeout.signal))
            .argv
    timeout.signal.throwIfAborted()
    const child = ctx.subprocess.spawn({
      argv: wrapped,
      cwd,
      env: { ...CLEAN_ENV, ...env },
      signal: timeout.signal,
      graceMs: config.graceMs,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: config.maxOutputBytes },
        stderr: { maxBytes: config.maxOutputBytes },
      },
    })
    try {
      const outcome = await child.done
      timeout.signal.throwIfAborted()
      const captured = child.collected
      if (captured.stdout === undefined || captured.stderr === undefined) {
        throw new Error('workspace command captured no output streams')
      }
      const stdout = captured.stdout.readFrom(0)
      const stderr = captured.stderr.readFrom(0)
      if (outcome.exitCode === null || outcome.exitCode !== 0) {
        throw new Error(
          `workspace command failed (${outcome.signal ?? outcome.exitCode}): ${stderr.text.trim()}`,
        )
      }
      if (stdout.lossy) throw new Error('workspace command output exceeds maxOutputBytes')
      return stdout.text
    } finally {
      child.terminate()
      await child.waitForExit()
    }
  } finally {
    timeout[Symbol.dispose]()
  }
}

/** Run one jj subcommand with paging and color disabled. */
export async function runJj(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string> {
  return runCommand(
    ctx,
    config,
    policy,
    cwd,
    [config.jjCommand, '--no-pager', '--color=never', ...args],
    signal,
  )
}

const APPEND_RECORD = `
import fs from 'node:fs/promises';
import path from 'node:path';
async function main() {
  const [file, line] = process.argv.slice(1);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, line, { encoding: 'utf8', flag: 'a' });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
`

/** Append one task record through the sandboxed Node child. */
export async function appendTaskRecord(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  projectRoot: string,
  recordPath: string,
  line: string,
  signal: AbortSignal,
): Promise<void> {
  await runCommand(
    ctx,
    config,
    policy,
    projectRoot,
    [config.nodeCommand, '--input-type=module', '-e', APPEND_RECORD, recordPath, line],
    signal,
  )
}

/** Allocate the pool and destination through the sandboxed Node child. */
export async function prepareJjDirectory(
  ctx: Context,
  config: ProcessConfig,
  policy: SandboxExecutionPolicy,
  projectRoot: string,
  poolPath: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  await runCommand(
    ctx,
    config,
    policy,
    projectRoot,
    [config.nodeCommand, '--input-type=module', '-e', PREPARE_DIRECTORY, poolPath, destination],
    signal,
  )
}

/** Validate the two limits this adapter adds beyond the stock configuration. */
export function validateProcessConfig(
  config: ProcessConfig & { workspaceDirectory: string },
): void {
  for (const key of ['timeoutMs', 'graceMs', 'maxOutputBytes'] as const) {
    const value = config[key]
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `jj-workspace: ${key} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
  }
  const directory = config.workspaceDirectory
  if (
    directory.length === 0 ||
    isAbsolute(directory) ||
    directory.includes('\\') ||
    directory.includes(':') ||
    !directory.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  ) {
    throw new Error(
      'jj-workspace: workspaceDirectory must be a relative directory without dot segments',
    )
  }
  if (config.jjCommand.trim().length === 0)
    throw new Error('jj-workspace: jjCommand must not be empty')
}
