/**
 * The two prompts: the instruction that asks the current agent to write a brief, and the first prompt of the fresh session.
 * @module dsh-handoff/prompt
 */
import type { PendingHandoff } from './pending.js'

/** The executor-side loop rules a review-loop handoff must carry up front. */
function reviewBootstrapSection(runId: string, maxRounds: number): string {
  return [
    '',
    '---',
    `[triggers] 本次任务带自动审核循环（预算 ${maxRounds} 轮）：每轮实现与自查（含测试/构建验证）完成后，直接以最终回复交付——写明改了什么、如何验证、证据在哪里，正常结束回合即自动送审，无需调用工具（也可显式调用 trigger_signal 提交 deliver）。`,
    `需要用户决定时，调用 trigger_signal 工具提交（runId=${runId}、outcome=needs_user、summary 写明所需决定），此时不要正常收尾——正常结束会被当作交付。审核意见会作为下一条用户消息送达；返工意见只处理阻塞本轮目标的部分。`,
  ].join('\n')
}

/** The first prompt of the fresh session: the brief plus bootstrap guidance. */
export function bootstrapPrompt(
  pending: PendingHandoff,
  brief: string,
  review?: { runId: string; maxRounds: number },
): string {
  const crossNote = pending.crossWorkspace
    ? `本次交接来自另一个工作区（${pending.cwd}）：简报中的原路径对你只读，写入一律在当前工作区进行；简报与当前工作区不符时以当前工作区为准。`
    : ''
  return [
    `[handoff] 你是新会话，无历史；上一会话的全部上下文在下方简报中（源 ${pending.originLabel ?? String(pending.agent.id)}，文件 ${pending.briefPath}）。${crossNote}直接开始执行 Task：按 Next steps 推进；仅对简报未覆盖且无法查证的信息询问用户。`,
    '',
    '---',
    brief,
    '---',
    ...(review === undefined ? [] : [reviewBootstrapSection(review.runId, review.maxRounds)]),
  ].join('\n')
}
