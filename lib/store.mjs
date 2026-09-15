// 工作流存储：路径管理、schema 迁移、原子落盘，以及 13+2 个 MCP 工具的实现。
//
// 状态推导在 lib/state.mjs，结构校验在 lib/schema.mjs，提示词/批次在 lib/planner.mjs，
// 展示在 lib/render.mjs —— 本文件只负责"把工作流安全地存下来、按语义改一改"。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeFlowId, normalizeStep, sanitizeName, validateStructure } from './schema.mjs';
import { SETTLED, computeReady, evaluateGates, settledStatus, stepById } from './state.mjs';
import { renderMarkdown, readyText, statusText } from './render.mjs';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
let ROOT = path.resolve(SERVER_DIR, '..');

export function setRoot(dir) { ROOT = path.resolve(dir); }
export function rootDir() { return ROOT; }
export function flowsDir() { return path.join(ROOT, 'flows'); }
export function trashDir() { return path.join(ROOT, 'trash'); }

function ensureDirs() {
  fs.mkdirSync(flowsDir(), { recursive: true });
  fs.mkdirSync(trashDir(), { recursive: true });
}

// ---------- 正在执行的流（进程内登记，用于区分"真在跑"与"崩溃残留的 running"）----------

const LIVE_RUNS = new Set();
export function registerLiveRun(id) { LIVE_RUNS.add(id); }
export function unregisterLiveRun(id) { LIVE_RUNS.delete(id); }
export function isLiveRun(id) { return LIVE_RUNS.has(id); }

// ---------- 路径 ----------

// 流 id 直接来自工具参数，必须当成不可信输入处理：先做字符级拒绝，
// 再对 resolve 后的结果做包含性校验，双保险防止 (id="../../x") 这类穿越。
function flowPath(id) {
  const safe = assertSafeFlowId(id);
  const base = path.resolve(flowsDir());
  const p = path.resolve(base, `${safe}.json`);
  const rel = path.relative(base, p);
  if (rel !== `${safe}.json` || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`非法的工作流 id："${id}"`);
  }
  return p;
}

// ---------- 持久化 ----------

// 先写临时文件再 rename：避免并发读（readline 会并发派发多条请求）读到写了一半的 JSON。
function atomicWrite(target, content) {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略清理失败 */ }
    throw e;
  }
}

function writeMarkdown(flow) {
  atomicWrite(path.join(flowsDir(), `${flow.id}.WORKFLOW.md`), renderMarkdown(flow));
}

function save(flow) {
  flow.updatedAt = new Date().toISOString();
  atomicWrite(flowPath(flow.id), JSON.stringify(flow, null, 2));
  writeMarkdown(flow);
}
export function saveFlow(flow) { save(flow); }

// schema 1 → 2 迁移：旧 done/skipped 布尔 → status；残留 running 回到 pending。
function migrate(flow) {
  if (flow.schema >= 2) return flow;
  flow.schema = 2;
  flow._migrated = true;
  flow.steps = flow.steps.map((raw, i) => {
    const base = normalizeStep({ ...raw, id: raw.id }, i);
    base.status = raw.status ?? (raw.done ? 'done' : raw.skipped ? 'skipped' : 'pending');
    if (!SETTLED.has(base.status)) base.status = 'pending';
    base.result = raw.result ?? null;
    base.notes = raw.notes ?? null;
    base.skipReason = raw.skipReason ?? null;
    base.failureReason = raw.failureReason ?? null;
    base.attempts = Number(raw.attempts) || 0;
    base.completedAt = raw.completedAt ?? null;
    return base;
  });
  return flow;
}

// 崩溃残留：进程已不在跑这条流，却还有 running —— 说明上次执行没跑完，
// 一律退回 pending，这样状态显示诚实、续跑也能重新派发（断点续跑的关键一环）。
function recoverStaleRunning(flow) {
  if (LIVE_RUNS.has(flow.id)) return false;
  let changed = false;
  for (const s of flow.steps) {
    if (s.status === 'running') { s.status = 'pending'; changed = true; }
  }
  return changed;
}

export function loadFlow(id) {
  const p = flowPath(id);
  if (!fs.existsSync(p)) throw new Error(`工作流 "${id}" 不存在（用 list_workflows 查看现有列表）`);
  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`工作流 "${id}" 的数据文件已损坏，无法解析：${e.message}`);
  }
  if (!flow || !Array.isArray(flow.steps)) throw new Error(`工作流 "${id}" 的数据文件结构异常（缺少 steps 数组）`);

  flow = migrate(flow);
  const recovered = recoverStaleRunning(flow);
  evaluateGates(flow);
  if (flow._migrated) { delete flow._migrated; save(flow); }
  else if (recovered) save(flow);
  return flow;
}

// ---------- 工具实现 ----------

export function createWorkflow({ name, description = '', steps, finalVerify }) {
  if (!name || typeof name !== 'string' || !name.trim()) throw new Error('name 必须是非空字符串');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('steps 必须是非空数组');
  ensureDirs();

  const normalized = steps.map(normalizeStep);
  const issues = validateStructure(normalized);
  if (issues.length) throw new Error('工作流结构不合法：\n- ' + issues.join('\n- '));

  const base = sanitizeName(name);
  let id;
  do { id = `${base}-${Math.random().toString(36).slice(2, 6)}`; } while (fs.existsSync(flowPath(id)));

  const flow = {
    schema: 2, id, name: String(name).trim(), description: String(description || ''),
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
  const flows = [];
  for (const f of fs.readdirSync(flowsDir()).filter(f => f.endsWith('.json'))) {
    try {
      const flow = JSON.parse(fs.readFileSync(path.join(flowsDir(), f), 'utf8'));
      const status = s => s.status ?? (s.done ? 'done' : s.skipped ? 'skipped' : 'pending');
      const steps = Array.isArray(flow.steps) ? flow.steps : [];
      flows.push({
        id: flow.id ?? f.replace(/\.json$/, ''),
        name: flow.name ?? '(未命名)',
        description: flow.description ?? '',
        schema: flow.schema ?? 1,
        total: steps.length,
        done: steps.filter(s => status(s) === 'done').length,
        skipped: steps.filter(s => status(s) === 'skipped').length,
        failed: steps.filter(s => status(s) === 'failed').length,
        updatedAt: flow.updatedAt,
      });
    } catch (e) {
      // 单个文件损坏不应让整个列表不可用
      flows.push({ id: f.replace(/\.json$/, ''), name: '(无法读取)', error: e.message });
    }
  }
  const rows = flows.map(f => f.error
    ? `  ⚠️ ${f.id}（无法读取：${f.error}）`
    : `  ${f.done}/${f.total} ${f.id}（${f.name}）${f.failed ? ` · 失败 ${f.failed}` : ''}${f.skipped ? ` · 跳过 ${f.skipped}` : ''}`);
  return { text: flows.length ? `共 ${flows.length} 条工作流：\n${rows.join('\n')}` : '（暂无工作流）', workflows: flows };
}

export function getWorkflow({ id, format = 'md' }) {
  const flow = loadFlow(id);
  if (format === 'json') {
    const readyIds = new Set(computeReady(flow).map(s => s.id));
    return {
      ...flow,
      steps: flow.steps.map(s => ({
        ...s,
        status: settledStatus(s) || s.status === 'running' ? s.status : (readyIds.has(s.id) ? 'ready' : 'pending'),
      })),
      ready: [...readyIds],
    };
  }
  const mdPath = path.join(flowsDir(), `${flow.id}.WORKFLOW.md`);
  if (!fs.existsSync(mdPath)) writeMarkdown(flow); // 手工删掉 md 也能自愈
  return { flow, document: fs.readFileSync(mdPath, 'utf8') };
}

export function nextStep({ id }) {
  const flow = loadFlow(id);
  return { text: readyText(flow), ready: computeReady(flow).map(s => s.id) };
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
  s.skipReason = null;
  s.completedAt = new Date().toISOString();
  evaluateGates(flow);
  save(flow);

  const autoSkipped = flow.steps.filter(x => x.status === 'skipped' && x.skipReason?.includes('门条件')).map(x => x.id);
  const text = `✅ ${stepId} 完成${autoSkipped.length ? `；门条件自动跳过：${autoSkipped.join('、')}` : ''}\n\n${readyText(flow)}`;
  return { text, autoSkipped, nextReady: computeReady(flow).map(x => x.id) };
}

export function skipStep({ id, stepId, reason = '人工跳过' }) {
  const flow = loadFlow(id);
  const s = stepById(flow, stepId);
  if (!s) throw new Error(`步骤 "${stepId}" 不存在`);
  if (SETTLED.has(s.status)) throw new Error(`${stepId} 已落定（${s.status}），不能再跳过`);
  s.status = 'skipped';
  s.skipReason = String(reason);
  evaluateGates(flow);
  save(flow);
  return { text: `⏭️ ${stepId} 已跳过（${reason}）。`, nextReady: computeReady(flow).map(x => x.id) };
}

export function undoStep({ id, stepId }) {
  const flow = loadFlow(id);
  if (!stepById(flow, stepId)) throw new Error(`步骤 "${stepId}" 不存在`);

  const affected = [];
  const queue = [stepId];
  while (queue.length) {
    const cur = queue.shift();
    if (affected.includes(cur)) continue;
    affected.push(cur);
    queue.push(...flow.steps.filter(x => x.dependsOn.includes(cur)).map(x => x.id));
  }
  for (const aid of affected) {
    const t = stepById(flow, aid);
    t.status = 'pending';
    t.result = null; t.notes = null; t.skipReason = null;
    t.failureReason = null; t.attempts = 0; t.completedAt = null;
  }
  save(flow);
  return { text: `↩️ 已撤销：${affected.join('、')}（含下游节点），状态/结果/失败原因一并清空。`, affected };
}

export function workflowStatus({ id }) {
  return statusText(loadFlow(id));
}

export function validateWorkflow({ id }) {
  const flow = loadFlow(id);
  const issues = validateStructure(flow.steps.map(s => ({ ...s })));
  return {
    text: issues.length ? `❌ 结构问题：\n- ${issues.join('\n- ')}` : '✓ 结构合法：连通、依赖与门条件一致。',
    ok: issues.length === 0,
    issues,
  };
}

export function deleteWorkflow({ id }) {
  ensureDirs();
  const src = flowPath(id);
  if (!fs.existsSync(src)) throw new Error(`工作流 "${id}" 不存在`);
  const dest = path.join(trashDir(), `${assertSafeFlowId(id)}-${Date.now()}.json`);
  fs.renameSync(src, dest);
  const md = path.join(flowsDir(), `${assertSafeFlowId(id)}.WORKFLOW.md`);
  if (fs.existsSync(md)) fs.rmSync(md, { force: true });
  return { text: `🗑️ 已归档删除（trash：${path.basename(dest)}），可用 restore_workflow 恢复。`, trashFile: path.basename(dest) };
}

// ---------- 回收站：归档删除的恢复闭环 ----------

const TRASH_NAME_RE = /^(?<id>.+)-(?<ts>\d{10,})\.json$/;

function listTrashEntries() {
  ensureDirs();
  return fs.readdirSync(trashDir())
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const st = fs.statSync(path.join(trashDir(), f));
      const m = TRASH_NAME_RE.exec(f);
      return { file: f, id: m?.groups.id ?? f.replace(/\.json$/, ''), deletedAt: st.mtime.toISOString(), size: st.size };
    })
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export function listTrash() {
  const entries = listTrashEntries();
  return {
    text: entries.length
      ? `回收站共 ${entries.length} 条：\n${entries.map(e => `  ${e.id}  ←  ${e.file}（删除于 ${e.deletedAt}）`).join('\n')}`
      : '回收站为空。',
    entries,
  };
}

// 恢复归档：id 既可以是原工作流 id（取最近一次删除），也可以是 trash 里的文件名。
export function restoreWorkflow({ id, overwrite = false }) {
  ensureDirs();
  if (!id) throw new Error('缺少 id（可用 list_trash 查看可恢复项）');
  const want = String(id).trim();
  const entries = listTrashEntries();
  const hit = entries.find(e => e.file === want) ?? entries.find(e => e.file === `${want}.json`) ?? entries.find(e => e.id === want);
  if (!hit) {
    throw new Error(entries.length
      ? `回收站里找不到 "${want}"。可恢复项：${entries.map(e => e.id).join('、')}`
      : `回收站里找不到 "${want}"（回收站为空）。`);
  }

  const destId = assertSafeFlowId(hit.id);
  const dest = flowPath(destId);
  if (fs.existsSync(dest) && !overwrite) {
    throw new Error(`工作流 "${destId}" 已存在，恢复会覆盖它。确认要覆盖请带 overwrite=true。`);
  }
  fs.renameSync(path.join(trashDir(), hit.file), dest);
  const flow = loadFlow(destId);
  return { text: `♻️ 已从归档恢复：${destId}（${flow.name}），当前 ${flow.steps.length} 个步骤。`, id: destId, flow };
}

// 供 executor / server 使用的原语（保持既有导入路径不变）
export { stepById, evaluateGates, computeReady, settledStatus } from './state.mjs';
