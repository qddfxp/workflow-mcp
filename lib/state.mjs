// 状态推导：六态步骤状态机 + 确定性门控。
//
// 状态语义（定死，README 与 docs/SPEC.md 一致）：
//   pending / ready / running / done / skipped / failed
//   ready 是派生态（未落定且当前可执行），不落盘。
//   failed 视为"已落定"：参与门条件求值时恒为布尔 false，且不算 skipped。
import { evalGate } from './gate.mjs';

export const SETTLED = new Set(['done', 'skipped', 'failed']);

export function stepById(flow, id) {
  return flow.steps.find(s => s.id === id);
}
export function settledStatus(s) {
  return Boolean(s) && SETTLED.has(s.status);
}
export function truthOf(s) {
  return Boolean(s) && s.status === 'done';
}
export function isFlowSettled(flow) {
  return flow.steps.every(settledStatus);
}

// 门条件求值用的"真值查询"：找不到的 id 恒为 false（容忍手工编辑过的数据，不抛错）
function truthFn(flow) {
  return id => truthOf(stepById(flow, id));
}

// 依赖全部落定后，把门条件的结论一次性写回 steps（幂等，循环到不动点）。
// 无门步骤：依赖里有 skipped/failed（分支没走通）→ 级联跳过，停止该分支。
// 需要"失败后走兜底"的分支，请显式写门（如 gate: "!T"）。
export function evaluateGates(flow) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of flow.steps) {
      if (settledStatus(s)) continue;
      if (!s.dependsOn.every(d => settledStatus(stepById(flow, d)))) continue;
      if (s.gate != null) {
        if (!evalGate(s.gate, truthFn(flow))) {
          s.status = 'skipped';
          s.skipReason = `门条件 "${s.gate}" 求值为假，自动跳过`;
          changed = true;
        }
      } else {
        const bad = s.dependsOn.filter(d => ['skipped', 'failed'].includes(stepById(flow, d)?.status));
        if (bad.length) {
          s.status = 'skipped';
          s.skipReason = `依赖 ${bad.join('、')} 未成功（skipped/failed），分支停止`;
          changed = true;
        }
      }
    }
  }
}

// 当前 READY 的步骤：未落定 + 依赖全部落定 + 门条件为真
export function computeReady(flow) {
  const truth = truthFn(flow);
  return flow.steps.filter(s =>
    !settledStatus(s) &&
    s.dependsOn.every(d => settledStatus(stepById(flow, d))) &&
    (s.gate == null || evalGate(s.gate, truth))
  );
}

// 展示用：把持久化状态映射成六态（pending 且就绪 → ready）
export function displayStatus(flow, step, readyIds) {
  if (settledStatus(step) || step.status === 'running') return step.status;
  return readyIds.has(step.id) ? 'ready' : 'pending';
}
