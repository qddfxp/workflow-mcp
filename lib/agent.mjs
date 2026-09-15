// Agent 循环 + 协议适配 + JSON Schema 校验（方案A 核心，见 docs/UPGRADE-agentic.md）。
//
// 把"单轮 LLM 调用"升级为"步骤内多轮工具调用循环"——模型返回 tool_calls 时在
// 服务器进程内执行工具并把结果回喂，直到给出最终文本或达到 maxTurns/超时。
//
// 职责边界（模块化后）：
//   lib/config.mjs      —— 环境变量与默认值
//   lib/agent-tools.mjs —— 六个内置工具与路径沙箱
//   lib/agent.mjs（本文件）—— 协议适配、JSON 容错、schema 校验、循环编排
//
// 天花板：MCP 进程够不到宿主的子代理/权限体系，这里只用 Node 标准库能力逼近。
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, LIMITS } from './config.mjs';
import { TOOL_DEFS, resolveInSandbox, runTool, cap, firstLine, shortArgs } from './agent-tools.mjs';

// 保持既有导出名不变（executor / 调用方按此引用）
export function llmConfig() {
  const { baseUrl, apiKey, model, maxConcurrency } = loadConfig().llm;
  return { baseUrl, apiKey, model, maxConcurrency };
}

// ---------- 协议适配器（OpenAI / Anthropic 兼容端点） ----------

function withSampling(body) {
  const { maxTokens, temperature } = loadConfig().llm;
  if (body.max_tokens == null) body.max_tokens = maxTokens;
  if (temperature != null && body.temperature == null) body.temperature = temperature;
  return body;
}

const OPENAI = {
  name: 'openai',
  chatUrl: (base) => `${base}/chat/completions`,
  headers: (apiKey) => ({ 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }),
  buildBody({ model, system, messages, tools }) {
    const wire = [];
    if (system) wire.push({ role: 'system', content: system });
    for (const m of messages) {
      if (m.role === 'user') wire.push({ role: 'user', content: m.text });
      else if (m.role === 'assistant') {
        wire.push({
          role: 'assistant',
          content: m.text || null,
          ...(m.toolCalls?.length ? {
            tool_calls: m.toolCalls.map((tc, i) => ({
              id: tc.id || `call_${i}`, type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
            })),
          } : {}),
        });
      } else if (m.role === 'tool_results') {
        for (const r of m.results) wire.push({ role: 'tool', tool_call_id: r.id, content: r.content });
      }
    }
    return withSampling({
      model, messages: wire, stream: false,
      ...(tools?.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    });
  },
  parse(data) {
    const choice = data?.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const raw = msg.content;
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(p => p?.text ?? '').join('') : '';
    // 容错：arguments 可能不是合法 JSON（截断/夹带文字），字段缺失时补 id
    const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
      .map((tc, i) => ({ id: tc?.id || `call_${i}`, name: tc?.function?.name, args: safeJsonArgs(tc?.function?.arguments) }))
      .filter(tc => typeof tc.name === 'string' && tc.name);
    return { text, toolCalls };
  },
};

const ANTHROPIC = {
  name: 'anthropic',
  chatUrl: (base) => `${base}${/\/v1$/.test(base) ? '' : '/v1'}/messages`,
  headers: (apiKey) => ({
    'content-type': 'application/json',
    'x-api-key': apiKey, authorization: `Bearer ${apiKey}`, // x-api-key 为 Anthropic 标准，Bearer 兼容 BigModel 等网关
    'anthropic-version': '2023-06-01',
  }),
  buildBody({ model, system, messages, tools }) {
    const wire = messages.map(m => {
      if (m.role === 'user') return { role: 'user', content: m.text };
      if (m.role === 'assistant') {
        const content = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const [i, tc] of (m.toolCalls ?? []).entries()) {
          content.push({ type: 'tool_use', id: tc.id || `toolu_${i}`, name: tc.name, input: (tc.args && typeof tc.args === 'object' && !Array.isArray(tc.args)) ? tc.args : {} });
        }
        return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] };
      }
      return { role: 'user', content: m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: String(r.content) })) };
    });
    return withSampling({
      model, stream: false,
      ...(system ? { system } : {}), messages: wire,
      ...(tools?.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    });
  },
  parse(data) {
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('');
    const toolCalls = blocks.filter(b => b?.type === 'tool_use')
      .map((b, i) => ({ id: b.id || `toolu_${i}`, name: b.name, args: (b.input && typeof b.input === 'object' && !Array.isArray(b.input)) ? b.input : {} }))
      .filter(tc => typeof tc.name === 'string' && tc.name);
    return { text, toolCalls };
  },
};

export function pickAdapter(baseUrl) {
  const forced = loadConfig().llm.protocol;
  if (forced === 'anthropic') return ANTHROPIC;
  if (forced === 'openai') return OPENAI;
  return /anthropic/i.test(baseUrl) ? ANTHROPIC : OPENAI;
}

// ---------- JSON 健壮性 ----------

export function safeJsonArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { value: raw };
  try { return JSON.parse(raw); } catch { /* 落到提取 */ }
  return extractBalanced(raw, '{', '}') ?? {};
}

// 从文本里提取第一个平衡的 {…} 或 […]（容忍前后夹带说明文字、字符串内的括号）
function extractBalanced(text, open, close) {
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

// 从最终文本提取 JSON：整段可解析则直接用；否则提取第一个平衡的 {...} / [...]
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* 继续提取 */ }
  return extractBalanced(t, '{', '}') ?? extractBalanced(t, '[', ']');
}

// ---------- 极简 JSON Schema 校验 ----------
// 覆盖工作流场景常用子集：type / enum / const / required / properties /
// items / minItems / maxItems / minimum / maximum / minLength / maxLength /
// pattern / additionalProperties:false。返回问题列表，空数组即通过。
export function validateSchema(schema, value) {
  const problems = [];
  check(schema, value, '$', problems);
  return problems;
}

function typeName(v) {
  return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
}
function matchType(t, v) {
  switch (t) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return true; // 未识别的 type 一律放行，避免误杀
  }
}

function check(s, v, at, out) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return;

  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some(t => matchType(t, v))) {
      out.push(`${at} 类型应为 ${types.join('|')}，实际 ${typeName(v)}`);
      return;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some(e => JSON.stringify(e) === JSON.stringify(v))) {
    out.push(`${at} 不在枚举 ${JSON.stringify(s.enum)} 内`);
  }
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) {
    out.push(`${at} 应恒等于 ${JSON.stringify(s.const)}`);
  }

  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) out.push(`${at} 应 ≥ ${s.minimum}，实际 ${v}`);
    if (typeof s.maximum === 'number' && v > s.maximum) out.push(`${at} 应 ≤ ${s.maximum}，实际 ${v}`);
  }
  if (typeof v === 'string') {
    if (typeof s.minLength === 'number' && v.length < s.minLength) out.push(`${at} 长度应 ≥ ${s.minLength}`);
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) out.push(`${at} 长度应 ≤ ${s.maxLength}`);
    if (typeof s.pattern === 'string') {
      let re = null;
      try { re = new RegExp(s.pattern); } catch { out.push(`${at} 的 pattern 不是合法正则：${s.pattern}`); }
      if (re && !re.test(v)) out.push(`${at} 不匹配 pattern ${s.pattern}`);
    }
  }

  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of s.required ?? []) if (!(r in v)) out.push(`${at} 缺少必填字段 "${r}"`);
    const props = s.properties ?? {};
    for (const [k, sub] of Object.entries(props)) if (k in v) check(sub, v[k], `${at}.${k}`, out);
    if (s.additionalProperties === false) {
      for (const k of Object.keys(v)) if (!(k in props)) out.push(`${at} 含未声明字段 "${k}"（additionalProperties: false）`);
    }
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) out.push(`${at} 元素数应 ≥ ${s.minItems}`);
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) out.push(`${at} 元素数应 ≤ ${s.maxItems}`);
    if (s.items) v.forEach((item, i) => check(s.items, item, `${at}[${i}]`, out));
  }
}

// ---------- 工具白名单 ----------

// 步骤 tools 必须落在服务器级允许集合内（WORKFLOW_TOOLS 覆盖，缺省为全部内置工具）。
// 注意：create_workflow 只会校验工具名是否存在于 KNOWN_TOOLS，是否被服务器放行在此判定。
export function resolveWhitelist(stepTools) {
  const base = loadConfig().stepDefaults.tools;
  if (Array.isArray(stepTools) && stepTools.length) {
    const denied = stepTools.filter(t => !base.includes(t));
    if (denied.length) {
      throw new Error(`步骤要求的工具超出服务器允许范围：${denied.join('、')}（当前允许：${base.join('、')}；可用 WORKFLOW_TOOLS / WORKFLOW_ALLOW_NET 调整）`);
    }
    return [...new Set(stepTools)];
  }
  return [...base];
}

function buildSystem({ sandbox, toolNames, outputSchema }) {
  const lines = [
    `你是工作流 auto 步骤内的执行 agent。工作沙箱目录：${sandbox}——所有文件访问都限定在该目录内，越界路径会被拒绝。`,
    `可用工具：${toolNames.join('、') || '（无）'}。需要读文件/写文件/搜索/执行命令/抓取网页时必须调用工具完成，禁止编造文件内容或命令输出。`,
    '工具返回"错误/已拦截"时，换一种做法或放弃该操作，不要反复重试同一动作。',
    '任务完成后输出一段简洁的最终结果文本（包含关键数字/路径/结论），不要再调用工具。',
  ];
  if (outputSchema) lines.push(`最终文本中必须包含一个符合以下 JSON Schema 的 JSON：${JSON.stringify(outputSchema)}`);
  return lines.join('\n');
}

// ---------- agent 循环 ----------

// 多轮工具调用循环。返回 { text, json, turns, toolCalls, blocked, errors }。
// outputSchema 配置时：最终文本提取 JSON 并校验，不符则带着错误重试一轮，仍不符则抛错（步骤失败）。
export async function agentLoop({
  prompt, system, model,
  timeoutMs, maxTurns, tools, sandboxCwd, outputSchema = null, signal,
} = {}) {
  const cfg = loadConfig();
  const { baseUrl, apiKey, model: defaultModel } = cfg.llm;
  if (!baseUrl || !apiKey) throw new Error('LLM 未配置（需要 LLM_BASE_URL 与 LLM_API_KEY）');

  const totalMs = Math.min(LIMITS.maxTimeoutMs, Math.max(LIMITS.minTimeoutMs, Number(timeoutMs) || cfg.stepDefaults.timeoutMs));
  const turnsCap = Math.min(LIMITS.maxTurns, Math.max(1, Math.trunc(Number(maxTurns) || cfg.stepDefaults.maxTurns)));

  const adapter = pickAdapter(baseUrl);
  const sandbox = path.resolve(sandboxCwd || process.cwd());
  fs.mkdirSync(sandbox, { recursive: true });
  const whitelist = resolveWhitelist(tools);
  const toolDefs = TOOL_DEFS.filter(t => whitelist.includes(t.name));
  const sys = system || buildSystem({ sandbox, toolNames: whitelist, outputSchema });
  const deadline = Date.now() + totalMs;
  const ctx = {
    sandbox, whitelist, deadline, signal,
    allowNet: cfg.security.allowNet,
    allowDangerous: cfg.security.allowDangerous,
  };

  const transcript = [{ role: 'user', text: prompt }];
  const trace = { turns: 0, toolCalls: 0, blocked: [], errors: [] };
  let schemaCorrections = 0;

  for (let turn = 1; turn <= turnsCap; turn++) {
    trace.turns = turn;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`步骤超时（预算 ${totalMs}ms 已用尽）`);

    const res = await fetch(adapter.chatUrl(baseUrl), {
      method: 'POST',
      headers: adapter.headers(apiKey),
      body: JSON.stringify(adapter.buildBody({
        model: model || defaultModel, system: sys, messages: transcript, tools: toolDefs,
      })),
      signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)].filter(Boolean)),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}${await errorDetail(res)}`);
    const turnRes = adapter.parse(await res.json());

    if (turnRes.toolCalls.length) {
      transcript.push({ role: 'assistant', text: turnRes.text, toolCalls: turnRes.toolCalls });
      const results = [];
      for (const tc of turnRes.toolCalls) {
        trace.toolCalls++;
        const r = await runTool(tc, ctx);
        if (r.blocked) trace.blocked.push(`${tc.name}(${shortArgs(tc.args)})：${firstLine(r.content)}`);
        else if (!r.ok) trace.errors.push(`${tc.name}(${shortArgs(tc.args)})：${firstLine(r.content)}`);
        results.push({ id: tc.id, name: tc.name, content: r.content });
      }
      transcript.push({ role: 'tool_results', results });
      continue;
    }

    const text = turnRes.text ?? '';
    if (!outputSchema) return { text, json: null, ...trace };
    const parsed = extractJson(text);
    const problems = parsed == null ? ['输出中找不到 JSON'] : validateSchema(outputSchema, parsed);
    if (!problems.length) return { text, json: parsed, ...trace };
    if (schemaCorrections >= 1) throw new Error(`outputSchema 不匹配（已按错误重试 1 轮仍未通过）：${problems.join('；')}`);
    schemaCorrections++;
    transcript.push({ role: 'assistant', text });
    transcript.push({
      role: 'user',
      text: `你的输出不符合要求的 JSON Schema：${problems.join('；')}。要求的 Schema：${JSON.stringify(outputSchema)}。请重新输出：只输出一个符合该 Schema 的 JSON，不要包含其他文字，也不要调用工具。`,
    });
  }
  throw new Error(`达到 maxTurns=${turnsCap} 仍未产出最终结果（可用 WORKFLOW_MAX_TURNS 或步骤 maxTurns 调大，或在提示词里约束输出）`);
}

// 单轮补全（verify reviewer / final_verify 用），无工具
export async function simpleCompletion({ system, prompt, model, timeoutMs, signal } = {}) {
  const cfg = loadConfig();
  const { baseUrl, apiKey, model: defaultModel } = cfg.llm;
  if (!baseUrl || !apiKey) throw new Error('LLM 未配置（需要 LLM_BASE_URL 与 LLM_API_KEY）');
  const totalMs = Math.min(LIMITS.maxTimeoutMs, Math.max(LIMITS.minTimeoutMs, Number(timeoutMs) || cfg.verify.timeoutMs));
  const adapter = pickAdapter(baseUrl);
  const res = await fetch(adapter.chatUrl(baseUrl), {
    method: 'POST',
    headers: adapter.headers(apiKey),
    body: JSON.stringify(adapter.buildBody({ model: model || defaultModel, system, messages: [{ role: 'user', text: prompt }], tools: [] })),
    signal: AbortSignal.any([signal, AbortSignal.timeout(totalMs)].filter(Boolean)),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}${await errorDetail(res)}`);
  return adapter.parse(await res.json()).text;
}

// HTTP 非 2xx 时尽量带上端点返回的错误正文，便于定位（密钥错/模型名错/额度不足）
async function errorDetail(res) {
  try {
    const body = cap(await res.text(), 300).replace(/\s+/g, ' ');
    return body ? `：${body}` : '';
  } catch { return ''; }
}

// 供外部复用的沙箱与截断工具
export { resolveInSandbox, cap };
