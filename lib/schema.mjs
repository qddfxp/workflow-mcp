// 工作流结构定义：步骤规范化、创建期结构校验、流 id 安全化。
//
// 这里只关心"一条工作流长什么样、合不合法"，不碰持久化也不碰状态推导。
// schema 2 的步骤字段见 docs/UPGRADE-agentic.md 第五节。
import { gateVariables, isValidIdent } from './gate.mjs';
import { KNOWN_TOOLS } from './agent-tools.mjs';
import { LIMITS } from './config.mjs';

// 步骤在未显式配置时的取值（null = 交给服务器级默认值 / 不适用）
export const STEP_DEFAULTS = {
  mode: 'manual', agentPrompt: null, model: null, timeoutMs: null, maxRetries: null,
  tools: null, maxTurns: null, outputSchema: null, verify: null, sandboxCwd: null,
};

// ---------- id 安全 ----------

// 流 id 会成为文件名（flows/<id>.json）。这里拒绝一切可能穿越目录的输入，
// 调用方（store.flowPath）还会再做一次 resolve 后的包含性校验作为第二道防线。
export function assertSafeFlowId(id) {
  const s = String(id ?? '').trim();
  if (!s) throw new Error('缺少工作流 id');
  if (s.includes('..') || /[/\\]/.test(s) || /[\x00-\x1f]/.test(s)) {
    throw new Error(`非法的工作流 id："${s}"（不允许路径分隔符、.. 或控制字符）`);
  }
  return s;
}

// 由工作流名称派生文件名安全的部分
export function sanitizeName(name) {
  const clean = String(name || '')
    .replace(/[^A-Za-z0-9_\u4e00-\u9fff.-]/g, '')  // 只保留安全字符
    .replace(/\.{2,}/g, '.')                        // 折叠连续点，杜绝 ..
    .replace(/^[.-]+|[.-]+$/g, '')                  // 去掉首尾的点/连字符
    .slice(0, 60);
  return clean || 'flow';
}

// ---------- 步骤规范化 ----------

export function normalizeStep(raw, i) {
  if (!raw || typeof raw.title !== 'string' || !raw.title.trim()) {
    throw new Error(`第 ${i + 1} 个步骤缺少 title`);
  }
  const s = {
    id: String(raw.id ?? `step-${String(i + 1).padStart(2, '0')}`).trim(),
    title: raw.title.trim(),
    instruction: typeof raw.instruction === 'string' ? raw.instruction : '',
    dependsOn: Array.isArray(raw.dependsOn) ? [...new Set(raw.dependsOn.map(String))] : [],
    gate: typeof raw.gate === 'string' && raw.gate.trim() ? raw.gate.trim() : null,
    ...structuredClone(STEP_DEFAULTS),
    status: 'pending', result: null, notes: null, skipReason: null,
    failureReason: null, attempts: 0, completedAt: null,
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
  if (raw.timeoutMs != null) {
    const n = Number(raw.timeoutMs);
    if (!Number.isFinite(n) || n < LIMITS.minTimeoutMs || n > LIMITS.maxTimeoutMs) {
      throw new Error(`${s.id} 的 timeoutMs 必须是 ${LIMITS.minTimeoutMs}-${LIMITS.maxTimeoutMs} 之间的数字`);
    }
    s.timeoutMs = Math.trunc(n);
  }
  if (raw.maxRetries != null) {
    const n = Number(raw.maxRetries);
    if (!Number.isInteger(n) || n < 0 || n > LIMITS.maxRetries) {
      throw new Error(`${s.id} 的 maxRetries 必须是 0-${LIMITS.maxRetries} 的整数`);
    }
    s.maxRetries = n;
  }
  // ---- agent 循环扩展字段（全部可选）----
  if (raw.tools != null) {
    if (!Array.isArray(raw.tools) || raw.tools.some(t => typeof t !== 'string')) throw new Error(`${s.id} 的 tools 必须是字符串数组`);
    const unknown = raw.tools.filter(t => !KNOWN_TOOLS.includes(t));
    if (unknown.length) throw new Error(`${s.id} 的 tools 含未知工具：${unknown.join('、')}（可用：${KNOWN_TOOLS.join('、')}）`);
    s.tools = [...new Set(raw.tools)];
  }
  if (raw.maxTurns != null) {
    const n = Number(raw.maxTurns);
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxTurns) throw new Error(`${s.id} 的 maxTurns 必须是 1-${LIMITS.maxTurns} 的整数`);
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

// ---------- 创建期结构校验 ----------

// 返回问题清单（空数组 = 合法）。不做模型调用，纯确定性检查。
export function validateStructure(steps) {
  const issues = [];
  const ids = steps.map(s => s.id);

  for (const id of ids) {
    if (!isValidIdent(id)) {
      issues.push(`步骤 id "${id}" 含非法字符（只允许中英文、数字、下划线、连字符）`);
    }
  }
  if (new Set(ids).size !== ids.length) issues.push('存在重复的步骤 id');

  for (const s of steps) {
    for (const d of s.dependsOn) {
      if (d === s.id) issues.push(`${s.id} 依赖自身`);
      else if (!ids.includes(d)) issues.push(`${s.id} 的依赖 "${d}" 不存在`);
    }
    if (s.gate != null) {
      try {
        for (const v of gateVariables(s.gate)) {
          if (!s.dependsOn.includes(v)) issues.push(`${s.id} 的门条件引用了 "${v}"，但它不在 dependsOn 里（门条件只允许引用直接依赖，否则永远无法求值）`);
        }
      } catch (e) {
        issues.push(`${s.id} 的门条件语法错误：${e.message}`);
      }
    }
  }

  // 依赖环检测（三色标记 + 栈回溯，输出具体环路）
  const color = Object.fromEntries(ids.map(i => [i, 0]));
  const byId = new Map(steps.map(s => [s.id, s]));
  function dfs(id, stack) {
    color[id] = 1;
    stack.push(id);
    const node = byId.get(id);
    for (const d of node ? node.dependsOn : []) {
      if (!byId.has(d)) continue;                      // 悬空依赖已在上面报告
      if (color[d] === 1) issues.push(`存在依赖环：${stack.concat(d).join(' → ')}`);
      else if (color[d] === 0) dfs(d, stack);
    }
    color[id] = 2;
    stack.pop();
  }
  for (const id of ids) if (color[id] === 0) dfs(id, []);

  return issues;
}
