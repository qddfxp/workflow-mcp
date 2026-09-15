// 提示词拼装 + 批次规划：方案A（自含执行器）与方案B（宿主派发）共用这一套。
//
// 确定性要求：批次只由 DAG 与门条件推导，不含任何随机排序；批内并行、批间串行。
import path from 'node:path';
import { evalGate } from './gate.mjs';
import { SETTLED, settledStatus, stepById } from './state.mjs';
import { loadConfig } from './config.mjs';

// 上游结果进提示词前的"瘦身"：去掉 _meta 这类执行元数据（attempts/turns/blocked…），
// 它们对下游判断没有价值，却会让提示词迅速膨胀，因此不入模型上下文。
const RESULT_BRIEF_MAX = 600;
export function briefResult(result, max = RESULT_BRIEF_MAX) {
  if (result == null) return '';
  let v = result;
  if (v && typeof v === 'object' && !Array.isArray(v) && '_meta' in v) {
    const { _meta, ...rest } = v;
    v = rest;
  }
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  if (!s || s === '{}') return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// 步骤的运行时参数：显式配置优先，其余取服务器级默认值（lib/config.mjs）。
export function resolveStepRuntime(step) {
  const d = loadConfig().stepDefaults;
  return {
    model: step.model ?? null,
    timeoutMs: step.timeoutMs ?? d.timeoutMs,
    maxTurns: step.maxTurns ?? d.maxTurns,
    maxRetries: step.maxRetries ?? d.maxRetries,
    tools: step.tools ?? null,
    sandboxCwd: step.sandboxCwd ?? d.sandboxCwd,
  };
}

// 沙箱目录：步骤级 > 服务器级（WORKFLOW_SANDBOX）> 工作流根目录
export function resolveSandbox(step, root) {
  const rel = resolveStepRuntime(step).sandboxCwd;
  return rel ? path.resolve(root, rel) : root;
}

// 拼装给执行者（模型或宿主子代理）的提示词
export function buildPrompt(flow, step) {
  const upstream = step.dependsOn.map(d => {
    const dep = stepById(flow, d);
    const brief = briefResult(dep?.result);
    return `- ${d}（${dep?.title ?? '?'}）：${dep?.status ?? '?'}${brief ? ` ${brief}` : ''}`;
  });
  return [
    `【工作流】${flow.name}${flow.description ? ` — ${flow.description}` : ''}`,
    `【步骤】${step.title}（id: ${step.id}）`,
    `【指令】${step.agentPrompt || step.instruction || '请完成该步骤。'}`,
    upstream.length ? `【上游依赖结果】\n${upstream.join('\n')}` : '',
    '请直接执行并输出该步骤的结果（简洁、结构化，含关键数字/路径/结论）。',
  ].filter(Boolean).join('\n');
}

// 把互不依赖的 READY 步骤按拓扑分批：批内并行、批间串行。仅收 auto 步骤。
// 内部用一份"影子副本"模拟推进门条件（=== 全部成功），因此批次是理想情况下的投影；
// 宿主实际出现失败/跳过时，应重新调用 dispatch_batches 取新批次。
export function planBatches(flow) {
  const sim = flow.steps.map(s => ({
    id: s.id, dependsOn: s.dependsOn, gate: s.gate, mode: s.mode,
    status: s.status, result: s.result,
  }));
  const byId = Object.fromEntries(sim.map(s => [s.id, s]));
  const truth = id => byId[id]?.status === 'done';
  const simReady = () => sim.filter(s =>
    !settledStatus(s) &&
    s.dependsOn.every(d => settledStatus(byId[d])) &&
    (s.gate == null || evalGate(s.gate, truth))
  );

  const batches = [];
  for (let guard = 0; guard <= sim.length; guard++) {
    // 影子推进：与 evaluateGates 同一套规则（门为假跳过；无门但依赖未成功也跳过）
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of sim) {
        if (settledStatus(s)) continue;
        if (!s.dependsOn.every(d => settledStatus(byId[d]))) continue;
        const bad = s.dependsOn.filter(d => ['skipped', 'failed'].includes(byId[d]?.status));
        if (s.gate != null ? !evalGate(s.gate, truth) : bad.length) {
          s.status = 'skipped';
          changed = true;
        }
      }
    }
    const ready = simReady().filter(s => s.mode === 'auto');
    if (!ready.length) break;
    batches.push(ready.map(simStep => {
      const real = stepById(flow, simStep.id);
      const rt = resolveStepRuntime(real);
      return {
        stepId: simStep.id,
        title: real.title,
        prompt: buildPrompt(flow, real),
        upstreamResults: Object.fromEntries(simStep.dependsOn.map(d => [d, byId[d]?.result ?? null])),
        model: real.model,
        timeoutMs: real.timeoutMs,
        maxRetries: real.maxRetries,
        tools: real.tools,
        maxTurns: real.maxTurns,
        sandboxCwd: real.sandboxCwd,
        outputSchema: real.outputSchema,
        verify: real.verify,
        effective: rt, // 服务器会实际采用的默认值，便于宿主对齐行为
      };
    }));
    for (const s of ready) { s.status = 'done'; s.result = { note: '模拟成功' }; }
  }

  const manualReady = simReady().map(s => s.id);
  const blocked = sim
    .filter(s => !SETTLED.has(s.status))
    .map(s => s.id)
    .filter(id => !manualReady.includes(id));
  return { batches, manualReady, blocked };
}
