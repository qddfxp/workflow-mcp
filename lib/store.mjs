// 工作流存储与核心逻辑：DAG + 确定性门控 + 6 态步骤状态机（schema 2）+ 可续跑，落盘 JSON + WORKFLOW.md。
// 状态语义（定死）：pending / running / done / skipped / failed；ready 为派生态（未落定且当前可执行）。
// failed 视为“已落定”：参与门条件求值时恒为布尔 false，且不算 skipped。
// schema 2 步骤字段含 agent 循环扩展（tools/maxTurns/outputSchema/verify/sandboxCwd，见 docs/UPGRADE-agentic.md）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalGate, gateVariables } from './gate.mjs';
import { KNOWN_TOOLS } from './agent.mjs';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
let ROOT = path.resolve(SERVER_DIR, '..');
const SETTLED = new Set(['done', 'skipped', 'failed']);

export function setRoot(dir) { ROOT = dir; }
export function rootDir() { return ROOT; }
export function flowsDir() { return path.join(ROOT, 'flows'); }
function trashDir() { return path.join(ROOT, 'trash'); }
function ensureDirs() {
  fs.mkdirSync(flowsDir(), { recursive: true });
  fs.mkdirSync(trashDir(), { recursive: true });
}

function sanitizeName(name) {
  const clean = String(name || '').replace(/[/\\:*?"<>|\x00-\x1f]/g, '').trim().replace(/\s+/g, '-');
  return clean || 'flow';
}
function flowPath(id) { return path.join(flowsDir(), `${id}.json`); }

// ---------- 步骤规范化与校验 ----------

const STEP_DEFAULTS = {
  mode: 'manual', agentPrompt: null, model: null, timeoutMs: null, maxRetries: null,
  tools: null, maxTurns: null, outputSchema: null, verify: null, sandboxCwd: null,
};

function normalizeStep(raw, i) {
  if (!raw || typeof raw.title !== 'string' || !raw.title.trim()) throw new Error(`第 ${i + 1} 个步骤缺少 title`);
  const s = {
    id: String(raw.id ?? `step-${String(i + 1).padStart(2, '0')}`).trim(),
    title: raw.title.trim(),
    instruction: typeof raw.instruction === 'string' ? raw.instruction : '',
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
    gate: typeof raw.gate === 'string' && raw.gate.trim() ? raw.gate.trim() : null,
    ...structuredClone(STEP_DEFAULTS),
    status: 'pending', result: null, notes: null, failureReason: null, attempts: 0, completedAt: null,
  };
  if (raw.mode != null) {
    if (!['manual', 'auto'].includes(raw.mode)) throw new Error(`${s.id} 的 mode 只能是 manual 或 auto`);
    s.mode = raw.mode;
  }
  for (const k of ['agentPrompt', 'model']) {
    if (raw[k] != null) {
      if (typeof raw[k] !== 'string') throw new Error(`${s.id} 的 ${k} 必须是字符串`);
      s[k] = raw[k];
    }
  }
  for (const k of ['timeoutMs', 'maxRetries']) {
    if (raw[k] != null) {
      const n = Number(raw[k]);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${s.id} 的 ${k} 必须是非负数字`);
      s[k] = n;
    }
  }
  // ---- agent 循环扩展字段（docs/UPGRADE-agentic.md 第五节，全部可选）----
  if (raw.tools != null) {
    if (!Array.isArray(raw.tools) || raw.tools.some(t => typeof t !== 'string')) throw new Error(`${s.id} 的 tools 必须是字符串数组`);
    const unknown = raw.tools.filter(t => !KNOWN_TOOLS.includes(t));
    if (unknown.length) throw new Error(`${s.id} 的 tools 含未知工具：${unknown.join('、')}（可用：${KNOWN_TOOLS.join('、')}）`);
    s.tools = [...new Set(raw.tools)];
  }
  if (raw.maxTurns != null) {
    const n = Number(raw.maxTurns);
    if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error(`${s.id} 的 maxTurns 必须是 1-64 的整数`);
    s.maxTurns = n;
  }
  if (raw.outputSchema != null) {
    if (typeof raw.outputSchema !== 'object' || Array.isArray(raw.outputSchema)) throw new Error(`${s.id} 的 outputSchema 必须是 JSON Schema 对象`);
    s.outputSchema = raw.outputSchema;
  }
  for (const k of ['verify', 'sandboxCwd']) {
    if (raw[k] != null) {
      if (typeof raw[k] !== 'string' || !raw[k].trim()) throw new Error(`${s.id} 的 ${k} 必须是非空字符串`);
      s[k] = raw[k].trim();
    }
  }
  return s;
}

export function validateStructure(steps) {
  const issues = [];
  const ids = steps.map(s => s.id);
  if (new Set(ids).size !== ids.length) issues.push('存在重复的步骤 id');
  for (const s of steps) {
    for (const d of s.dependsOn) {
      if (!ids.includes(d)) issues.push(`${s.id} 的依赖 "${d}" 不存在`);
      if (d === s.id) issues.push(`${s.id} 依赖自身`);
    }
    if (s.gate != null) {
      try {
        for (const v of gateVariables(s.gate)) {
          if (!s.dependsOn.includes(v)) issues.push(`${s.id} 的门条件引用了 "${v}"，但它不在 dependsOn 里（门条件只允许引用直接依赖，否则永远无法求值）`);
        }
      } catch (e) { issues.push(`${s.id} 的门条件语法错误：${e.message}`); }
    }
  }
  const color = Object.fromEntries(ids.map(i => [i, 0]));
  function dfs(id, stack) {
    color[id] = 1; stack.push(id);
    for (const s of steps) {
      if (s.id !== id) continue;
      for (const d of s.dependsOn) {
        if (color[d] === 1) issues.push(`存在依赖环：${stack.concat(d).join(' → ')}`);
        else if (color[d] === 0) dfs(d, stack);
      }
    }
    color[id] = 2; stack.pop();
  }
  for (const id of ids) if (color[id] === 0) dfs(id, []);
  return issues;
}

// ---------- 状态推导 ----------

function stepById(flow, id) { return flow.steps.find(s => s.id === id); }
function settledStatus(s) { return SETTLED.has(s.status); }
function truthOf(s) { return s.status === 'done'; } // failed/skipped → false

function evaluateGates(flow) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of flow.steps) {
      if (settledStatus(s)) continue;
      if (!s.dependsOn.every(d => settledStatus(stepById(flow, d)))) continue;
      if (s.gate != null) {
        if (!evalGate(s.gate, id => truthOf(stepById(flow, id)))) {
          s.status = 'skipped';
          s.skipReason = `门条件 "${s.gate}" 求值为假，自动跳过`;
          changed = true;
        }
      } else {
        // 无门步骤：依赖有 skipped/failed（分支未走通）→ 级联跳过，停止该分支；
        // 需要“失败后兜底”的分支请显式写门（如 gate: "!T"）。
        const bad = s.dependsOn.filter(d => ['skipped', 'failed'].includes(stepById(flow, d).status));
        if (bad.length) {
          s.status = 'skipped';
          s.skipReason = `依赖 ${bad.join('、')} 未成功（skipped/failed），分支停止`;
          changed = true;
        }
      }
    }
  }
}

export function computeReady(flow) {
  return flow.steps.filter(s =>
    !settledStatus(s) &&
    s.dependsOn.every(d => settledStatus(stepById(flow, d))) &&
    (s.gate == null || evalGate(s.gate, id => truthOf(stepById(flow, id))))
  );
}

// ---------- 持久化（含 schema 1 → 2 迁移）----------

function migrate(flow) {
  if (flow.schema >= 2) return flow;
  flow.schema = 2;
  flow._migrated = true;
  flow.steps = flow.steps.map(raw => {
    const base = normalizeStep({ ...raw, id: raw.id }, flow.steps.indexOf(raw));
    // 旧字段 done/skipped 布尔 → status；running 残留一律回到 pending（进程死亡后重新可跑）
    base.status = raw.status ?? (raw.done ? 'done' : raw.skipped ? 'skipped' : 'pending');
    if (base.status === 'running') base.status = 'pending';
    if (!SETTLED.has(base.status)) base.status = 'pending';
    base.result = raw.result ?? null;
    base.notes = raw.notes ?? null;
    base.skipReason = raw.skipReason ?? null;
    base.completedAt = raw.completedAt ?? null;
    return base;
  });
  return flow;
}

function writeMarkdown(flow) {
  const readyIds = new Set(computeReady(flow).map(s => s.id));
  const icon = s => ({ done: '✅', skipped: '⏭️', failed: '❌', running: '🔄' }[s.status] ?? (readyIds.has(s.id) ? '▶️' : '⬜'));
  const esc = t => String(t).replace(/"/g, '#');
  const rows = flow.steps.map(s => {
    const tag = s.mode === 'auto' ? ' [auto]' : '';
    const note = s.status === 'skipped' ? (s.skipReason || '已跳过')
      : s.status === 'failed' ? `失败：${s.failureReason || '未知原因'}（尝试 ${s.attempts} 次）`
      : s.gate ? `门条件：${s.gate}` : '';
    const result = s.result ? JSON.stringify(s.result) : '';
    return `| ${s.id} ${esc(s.title)}${tag} | ${icon(s)} ${s.status} | ${note} | ${result.slice(0, 120) || ''} |`;
  });
  const lines = [
    `# ${flow.id}（${flow.name}）`,
    `> ${flow.description || ''}`,
    `**进度**：${flow.steps.filter(s => s.status === 'done').length}/${flow.steps.length} 完成 · 失败 ${flow.steps.filter(s => s.status === 'failed').length} · 更新于 ${flow.updatedAt}`,
    '```mermaid',
    'flowchart TD',
    ...flow.steps.map(s => `  ${s.id}["${esc(s.title)} ${({ done: '✅', skipped: '⏭️', failed: '❌', running: '🔄' }[s.status] ?? '')}"]`),
    ...flow.steps.flatMap(s => s.dependsOn.map(d => `  ${d} --> ${s.id}`)),
    '```',
    '| 节点 | 状态 | 说明 | 结果摘要 |',
    '|---|---|---|---|',
    ...rows,
  ];
  fs.writeFileSync(path.join(flowsDir(), `${flow.id}.WORKFLOW.md`), lines.join('\n') + '\n', 'utf8');
}

function save(flow) {
  flow.updatedAt = new Date().toISOString();
  fs.writeFileSync(flowPath(flow.id), JSON.stringify(flow, null, 2), 'utf8');
  writeMarkdown(flow);
}

export function loadFlow(id) {
  const p = flowPath(id);
  if (!fs.existsSync(p)) throw new Error(`工作流 "${id}" 不存在（用 list_workflows 查看现有列表）`);
  const flow = migrate(JSON.parse(fs.readFileSync(p, 'utf8')));
  evaluateGates(flow);
  if (flow._migrated) { delete flow._migrated; save(flow); } // schema1 → 2 迁移后立即回写
  return flow;
}
export function saveFlow(flow) { save(flow); }

// ---------- 提示词拼装与批次规划（方案A/B 共用）----------

export function buildPrompt(flow, step) {
  const upstream = step.dependsOn.map(d => {
    const dep = stepById(flow, d);
    return `- ${d}（${dep.title}）：${dep.status} ${dep.result ? JSON.stringify(dep.result) : ''}`;
  });
  return [
    `【工作流】${flow.name}${flow.description ? ` — ${flow.description}` : ''}`,
    `【步骤】${step.title}（id: ${step.id}）`,
    `【指令】${step.agentPrompt || step.instruction || '请完成该步骤。'}`,
    upstream.length ? `【上游依赖结果】\n${upstream.join('\n')}` : '',
    '请直接执行并输出该步骤的结果（简洁、结构化，含关键数字/路径/结论）。',
  ].filter(Boolean).join('\n');
}

// 把互不依赖的 READY 步骤按拓扑分批：批内并行、批间串行。仅收 auto 步骤；
// 模拟“全部成功”推进门条件，宿主实际失败后应重新调用。
export function planBatches(flow) {
  const sim = flow.steps.map(s => ({ id: s.id, title: s.title, instruction: s.instruction, agentPrompt: s.agentPrompt, mode: s.mode, dependsOn: s.dependsOn, gate: s.gate, status: s.status, result: s.result }));
  const byId = Object.fromEntries(sim.map(s => [s.id, s]));
  const settledSim = s => SETTLED.has(s.status);
  const truthSim = s => s.status === 'done';
  const simReady = () => sim.filter(s =>
    !settledSim(s) &&
    s.dependsOn.every(d => settledSim(byId[d])) &&
    (s.gate == null || evalGate(s.gate, id => truthSim(byId[id])))
  );
  const batches = [];
  for (let guard = 0; guard <= sim.length; guard++) {
    // 模拟门条件落定（与 evaluateGates 同一套规则：门为假跳过；无门但依赖未成功也跳过）
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of sim) {
        if (settledSim(s)) continue;
        if (!s.dependsOn.every(d => settledSim(byId[d]))) continue;
        const bad = s.dependsOn.filter(d => ['skipped', 'failed'].includes(byId[d].status));
        if (s.gate != null ? !evalGate(s.gate, id => truthSim(byId[id])) : bad.length) {
          s.status = 'skipped'; changed = true;
        }
      }
    }
    const ready = simReady().filter(s => s.mode === 'auto');
    if (!ready.length) break;
    batches.push(ready.map(simStep => {
      const real = stepById(flow, simStep.id);
      return {
        stepId: simStep.id, title: real.title, prompt: buildPrompt(flow, real),
        upstreamResults: Object.fromEntries(simStep.dependsOn.map(d => [d, byId[d].result ?? null])),
        model: real.model, timeoutMs: real.timeoutMs, maxRetries: real.maxRetries,
        tools: real.tools, maxTurns: real.maxTurns, sandboxCwd: real.sandboxCwd, outputSchema: real.outputSchema, verify: real.verify,
      };
    }));
    for (const s of ready) { s.status = 'done'; s.result = { note: '模拟成功' }; }
  }
  const manualReady = simReady().map(s => s.id);
  const blocked = sim.filter(s => !settledSim(s)).map(s => s.id).filter(id => !manualReady.includes(id));
  return { batches, manualReady, blocked };
}

// ---------- 工具实现（原有 10 个，行为保持）----------

export function createWorkflow({ name, description = '', steps, finalVerify }) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps 必须是非空数组');
  ensureDirs();
  const normalized = steps.map(normalizeStep);
  const issues = validateStructure(normalized);
  if (issues.length) throw new Error('工作流结构不合法：\n- ' + issues.join('\n- '));
  const id = `${sanitizeName(name)}-${Math.random().toString(36).slice(2, 6)}`;
  const flow = {
    schema: 2, id, name: String(name), description: String(description || ''),
    finalVerify: typeof finalVerify === 'string' && finalVerify.trim() ? finalVerify.trim() : null,
    finalVerifyResult: null,
    createdAt: new Date().toISOString(), updatedAt: null, steps: normalized,
  };
  evaluateGates(flow);
  save(flow);
  return flow;
}

export function listWorkflows() {
  ensureDirs();
  return fs.readdirSync(flowsDir()).filter(f => f.endsWith('.json')).map(f => {
    const flow = JSON.parse(fs.readFileSync(path.join(flowsDir(), f), 'utf8'));
    return {
      id: flow.id, name: flow.name, description: flow.description,
      total: flow.steps.length,
      done: flow.steps.filter(s => s.status === 'done' || s.done).length,
      skipped: flow.steps.filter(s => s.status === 'skipped' || s.skipped).length,
      failed: flow.steps.filter(s => s.status === 'failed').length,
      updatedAt: flow.updatedAt,
    };
  });
}

function readyText(flow) {
  const ready = computeReady(flow);
  const lines = ready.map(s => `${s.title} [${s.mode}]${s.instruction ? ` — ${s.instruction}` : ''}`);
  const autoHint = ready.some(s => s.mode === 'auto') ? '\n（含 auto 步骤：可用 run_workflow 自动执行，或 dispatch_batches 交宿主并行派发）' : '';
  if (ready.length) return `可立即执行的步骤：\n${lines.map((l, i) => `${i + 1}. [${ready[i].id}] ${l}`).join('\n')}\n\n完成后用 complete_step 提交（stepId=${ready.map(s => s.id).join(' 或 ')}）。${autoHint}`;
  if (flow.steps.every(s => SETTLED.has(s.status))) return '✅ 全部步骤已落定（完成/跳过/失败），工作流可以收尾。';
  return '当前没有就绪步骤（其余步骤在等依赖或门条件落定）。';
}

export function getWorkflow({ id, format = 'md' }) {
  const flow = loadFlow(id);
  if (format === 'json') {
    const readyIds = new Set(computeReady(flow).map(s => s.id));
    return {
      ...flow,
      steps: flow.steps.map(s => ({ ...s, status: settledStatus(s) || s.status === 'running' ? s.status : (readyIds.has(s.id) ? 'ready' : 'pending') })),
    };
  }
  const mdPath = path.join(flowsDir(), `${flow.id}.WORKFLOW.md`);
  return { flow, document: fs.readFileSync(mdPath, 'utf8') };
}

export function nextStep({ id }) {
  const flow = loadFlow(id);
  const ready = computeReady(flow);
  return { text: readyText(flow), ready: ready.map(s => s.id) };
}

export function completeStep({ id, stepId, result = null, notes = '' }) {
  const flow = loadFlow(id);
  const s = stepById(flow, stepId);
  if (!s) throw new Error(`步骤 "${stepId}" 不存在`);
  if (s.status === 'done') throw new Error(`${stepId} 已完成，重复提交请先 undo_step`);
  if (s.status === 'skipped') throw new Error(`${stepId} 已被跳过（${s.skipReason}），不能提交结果`);
  s.status = 'done';
  s.result = result;
  if (notes) s.notes = notes;
  s.failureReason = null;
  s.completedAt = new Date().toISOString();
  evaluateGates(flow);
  save(flow);
  const autoSkipped = flow.steps.filter(x => x.status === 'skipped' && x.skipReason?.includes('门条件')).map(x => x.id);
  const ready = computeStepReadyIds(flow);
  return {
    text: `✅ ${stepId} 完成${autoSkipped.length ? `；门条件自动跳过：${autoSkipped.join('、')}` : ''}\n\n${readyText(flow)}`,
    autoSkipped, nextReady: ready,
  };
}
function computeStepReadyIds(flow) { return computeReady(flow).map(s => s.id); }

export function skipStep({ id, stepId, reason = '人工跳过' }) {
  const flow = loadFlow(id);
  const s = stepById(flow, stepId);
  if (!s) throw new Error(`步骤 "${stepId}" 不存在`);
  if (SETTLED.has(s.status)) throw new Error(`${stepId} 已落定（${s.status}），不能再跳过`);
  s.status = 'skipped';
  s.skipReason = String(reason);
  evaluateGates(flow);
  save(flow);
  return { text: `⏭️ ${stepId} 已跳过（${reason}）。` };
}

export function undoStep({ id, stepId }) {
  const flow = loadFlow(id);
  if (!stepById(flow, stepId)) throw new Error(`步骤 "${stepId}" 不存在`);
  const affected = [];
  const dependents = sid => flow.steps.filter(x => x.dependsOn.includes(sid)).map(x => x.id);
  const queue = [stepId];
  while (queue.length) {
    const cur = queue.shift();
    if (affected.includes(cur)) continue;
    affected.push(cur);
    queue.push(...dependents(cur));
  }
  for (const aid of affected) {
    const t = stepById(flow, aid);
    t.status = 'pending'; t.result = null; t.notes = null; t.skipReason = null;
    t.failureReason = null; t.attempts = 0; t.completedAt = null;
  }
  save(flow);
  return { text: `↩️ 已撤销：${affected.join('、')}（含下游节点），状态/结果/失败原因一并清空。` };
}

export function workflowStatus({ id }) {
  const flow = loadFlow(id);
  const readyIds = new Set(computeReady(flow).map(s => s.id));
  const counts = { done: 0, skipped: 0, failed: 0, running: 0, pending: 0 };
  for (const s of flow.steps) counts[s.status in counts ? s.status : 'pending']++;
  const lines = flow.steps.map(s => {
    const tag = s.mode === 'auto' ? ' [auto]' : '';
    const extra = s.status === 'skipped' ? `（${s.skipReason}）` : s.status === 'failed' ? `（${s.failureReason || '未知'}）` : '';
    const shown = s.status === 'pending' && readyIds.has(s.id) ? '▶️ ready' : ICON[s.status] + ' ' + s.status;
    return `  ${shown} ${s.id} ${s.title}${tag}${extra}`;
  });
  return {
    text: `${flow.id}（${flow.name}）：${counts.done}/${flow.steps.length} 完成，${counts.skipped} 跳过，${counts.failed} 失败，${counts.running} 运行中，${counts.pending} 待办\n${lines.join('\n')}`,
    ...counts, total: flow.steps.length,
  };
}
const ICON = { done: '✅', skipped: '⏭️', failed: '❌', running: '🔄', pending: '⬜' };

export function validateWorkflow({ id }) {
  const flow = loadFlow(id);
  const issues = validateStructure(flow.steps.map(s => ({ ...s })));
  return { text: issues.length ? `❌ 结构问题：\n- ${issues.join('\n- ')}` : '✓ 结构合法：连通、依赖与门条件一致。', ok: issues.length === 0, issues };
}

export function deleteWorkflow({ id }) {
  ensureDirs();
  const src = flowPath(id);
  if (!fs.existsSync(src)) throw new Error(`工作流 "${id}" 不存在`);
  const dest = path.join(trashDir(), `${id}-${Date.now()}.json`);
  fs.renameSync(src, dest);
  const md = path.join(flowsDir(), `${id}.WORKFLOW.md`);
  if (fs.existsSync(md)) fs.rmSync(md);
  return { text: `🗑️ 已归档删除（trash：${path.basename(dest)}），可手工恢复。` };
}

// 供 executor 使用的原语
export { stepById, evaluateGates, settledStatus };
