// 展示层：WORKFLOW.md 渲染与面向人类的文本（next_step / workflow_status 用）。
//
// 与业务逻辑分离的好处：改排版不会碰到状态机；要换输出风格（比如英文）也只动这一个文件。
import { computeReady, displayStatus } from './state.mjs';

export const ICON = {
  done: '✅', skipped: '⏭️', failed: '❌', running: '🔄', ready: '▶️', pending: '⬜',
};

// markdown 表格单元格转义
function cell(t) {
  return String(t ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}
// mermaid 节点标签转义（引号/尖括号/竖线会破坏语法）
function label(t) {
  return String(t ?? '').replace(/["<>|#\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function skipNote(s) {
  return s.status === 'skipped' ? (s.skipReason || '已跳过')
    : s.status === 'failed' ? `失败：${s.failureReason || '未知原因'}（尝试 ${s.attempts} 次）`
      : s.gate ? `门条件：${s.gate}` : '';
}

function stepTag(s) {
  const mode = s.mode === 'auto' ? ' [auto]' : '';
  const detail = [
    s.tools ? `工具：${s.tools.join('/')}` : '',
    s.maxTurns ? `轮数≤${s.maxTurns}` : '',
    s.outputSchema ? 'outputSchema' : '',
    s.verify ? 'verify' : '',
    s.sandboxCwd ? `沙箱：${s.sandboxCwd}` : '',
  ].filter(Boolean);
  return mode + (detail.length ? `（${detail.join('，')}）` : '');
}

// 生成 flows/<id>.WORKFLOW.md 的内容
export function renderMarkdown(flow) {
  const readyIds = new Set(computeReady(flow).map(s => s.id));
  const rows = flow.steps.map(s => {
    const brief = s.result ? String(JSON.stringify(s.result)).slice(0, 160) : '';
    return `| ${cell(s.id)} ${cell(s.title)}${stepTag(s)} | ${ICON[displayStatus(flow, s, readyIds)] ?? '⬜'} ${displayStatus(flow, s, readyIds)} | ${cell(skipNote(s))} | ${cell(brief)} |`;
  });
  const counts = flow.steps.reduce((acc, s) => (acc[s.status] = (acc[s.status] ?? 0) + 1, acc), {});
  return [
    `# ${cell(flow.id)}（${cell(flow.name)}）`,
    flow.description ? `> ${cell(flow.description)}` : '',
    `**进度**：${counts.done ?? 0}/${flow.steps.length} 完成 · 跳过 ${counts.skipped ?? 0} · 失败 ${counts.failed ?? 0} · 更新于 ${flow.updatedAt}`,
    flow.finalVerify ? `**finalVerify**：${cell(flow.finalVerify)}${flow.finalVerifyResult ? ` → ${flow.finalVerifyResult.pass ? '通过' : '未通过'}` : ''}` : '',
    '',
    '```mermaid',
    'flowchart TD',
    ...flow.steps.map(s => `  ${s.id}["${label(s.title)} ${ICON[displayStatus(flow, s, readyIds)] ?? ''}"]`),
    ...flow.steps.flatMap(s => s.dependsOn.map(d => `  ${d} --> ${s.id}`)),
    '```',
    '',
    '| 节点 | 状态 | 说明 | 结果摘要 |',
    '|---|---|---|---|',
    ...rows,
  ].filter(l => l !== '').join('\n') + '\n';
}

// next_step / complete_step 返回的就绪提示
export function readyText(flow) {
  const ready = computeReady(flow);
  if (ready.length) {
    const lines = ready.map((s, i) => `${i + 1}. [${s.id}] ${s.title} [${s.mode}]${s.instruction ? ` — ${s.instruction}` : ''}`);
    const autoHint = ready.some(s => s.mode === 'auto')
      ? '\n（含 auto 步骤：可用 run_workflow 自动执行，或 dispatch_batches 交宿主并行派发）'
      : '';
    return `可立即执行的步骤：\n${lines.join('\n')}\n\n完成后用 complete_step 提交（stepId=${ready.map(s => s.id).join(' 或 ')}）。${autoHint}`;
  }
  if (flow.steps.every(s => ['done', 'skipped', 'failed'].includes(s.status))) {
    return '✅ 全部步骤已落定（完成/跳过/失败），工作流可以收尾。';
  }
  return '当前没有就绪步骤（其余步骤在等依赖或门条件落定）。';
}

// workflow_status 的文本 + 结构化计数
export function statusText(flow) {
  const readyIds = new Set(computeReady(flow).map(s => s.id));
  const counts = { done: 0, skipped: 0, failed: 0, running: 0, pending: 0 };
  for (const s of flow.steps) counts[s.status in counts ? s.status : 'pending']++;

  const lines = flow.steps.map(s => {
    const shown = displayStatus(flow, s, readyIds);
    const extra = s.status === 'skipped' ? `（${s.skipReason || '已跳过'}）`
      : s.status === 'failed' ? `（${s.failureReason || '未知'}）`
        : '';
    return `  ${ICON[shown] ?? '⬜'} ${shown} ${s.id} ${s.title}${stepTag(s)}${extra}`;
  });
  const text = [
    `${flow.id}（${flow.name}）：${counts.done}/${flow.steps.length} 完成，${counts.skipped} 跳过，${counts.failed} 失败，${counts.running} 运行中，${counts.pending} 待办`,
    ...lines,
  ].join('\n');
  return { text, ...counts, total: flow.steps.length };
}
