// Agent 循环 + 内置工具 + 安全沙箱（方案A 核心，见 docs/UPGRADE-agentic.md）：
// 把"单轮 LLM 调用"升级为"步骤内多轮工具调用循环"——模型返回 tool_calls 时在
// 服务器进程内执行工具并把结果回喂，直到给出最终文本或达到 maxTurns/超时。
//
// 协议适配：OpenAI 兼容（/chat/completions + tools/tool_calls）与
//   Anthropic 兼容（/v1/messages + tool_use/tool_result），按 LLM_PROTOCOL 或 URL 自动选择。
// 沙箱：所有工具路径规范化后强制限定在 sandboxCwd 内；bash 拦截危险命令；fetch_url 默认关闭。
// 天花板：MCP 进程够不到宿主的子代理/权限体系，这里只用 Node 标准库能力逼近。
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';

export const KNOWN_TOOLS = ['read_file', 'write_file', 'list_dir', 'grep', 'bash', 'fetch_url'];

const netAllowed = () => process.env.WORKFLOW_ALLOW_NET === '1';
const dangerousAllowed = () => process.env.WORKFLOW_ALLOW_DANGEROUS === '1';

export function llmConfig() {
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/+$/, '');
  return {
    baseUrl,
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || '',
    maxConcurrency: Math.max(1, Number(process.env.LLM_MAX_CONCURRENCY) || 4),
  };
}

function cap(s, n = 4000) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + `…(已截断，共 ${t.length} 字符)` : t;
}
function firstLine(s) { return cap(String(s ?? '').split('\n')[0], 200); }
function shortArgs(a) {
  try { const s = JSON.stringify(a ?? {}); return s.length > 80 ? s.slice(0, 80) + '…' : s; } catch { return '?'; }
}
function needStr(v, name) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${name} 必须是非空字符串`);
  return v;
}

// ---------- 协议适配器（OpenAI / Anthropic 兼容端点） ----------

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
    return {
      model, messages: wire, stream: false,
      ...(tools?.length ? { tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
    };
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
    return {
      model, max_tokens: Math.max(256, Number(process.env.LLM_MAX_TOKENS) || 4096), stream: false,
      ...(system ? { system } : {}), messages: wire,
      ...(tools?.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    };
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
  const forced = (process.env.LLM_PROTOCOL || '').trim().toLowerCase();
  if (forced === 'anthropic') return ANTHROPIC;
  if (forced === 'openai') return OPENAI;
  return /anthropic/i.test(baseUrl) ? ANTHROPIC : OPENAI;
}

// ---------- JSON 健壮性 ----------

function safeJsonArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { value: raw };
  try { return JSON.parse(raw); } catch { /* 落到提取 */ }
  const start = raw.indexOf('{');
  if (start !== -1) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)); } catch { break; } }
    }
  }
  return {};
}

// 从最终文本提取 JSON：整段可解析则直接用；否则提取第一个平衡的 {...} / [...]
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* 继续提取 */ }
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = t.indexOf(open);
    if (start === -1) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { break; } }
    }
  }
  return null;
}

// 极简 JSON Schema 校验（type/required/properties/items/enum），返回问题列表
export function validateSchema(schema, value) {
  const problems = [];
  check(schema, value, '$', problems);
  return problems;
}
function check(s, v, at, out) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return;
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const okType = types.some(t => {
      switch (t) {
        case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
        case 'array': return Array.isArray(v);
        case 'string': return typeof v === 'string';
        case 'number': return typeof v === 'number' && Number.isFinite(v);
        case 'integer': return Number.isInteger(v);
        case 'boolean': return typeof v === 'boolean';
        case 'null': return v === null;
        default: return true;
      }
    });
    if (!okType) { out.push(`${at} 类型应为 ${types.join('|')}，实际 ${Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v}`); return; }
  }
  if (Array.isArray(s.enum) && !s.enum.some(e => JSON.stringify(e) === JSON.stringify(v))) out.push(`${at} 不在枚举 ${JSON.stringify(s.enum)} 内`);
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of s.required ?? []) if (!(r in v)) out.push(`${at} 缺少必填字段 "${r}"`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in v) check(sub, v[k], `${at}.${k}`, out);
  }
  if (Array.isArray(v) && s.items) v.forEach((item, i) => check(s.items, item, `${at}[${i}]`, out));
}

// ---------- 安全沙箱 ----------

export function resolveInSandbox(sandbox, p) {
  const abs = path.resolve(sandbox, p);
  const rel = path.relative(path.resolve(sandbox), abs);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    const e = new Error(`路径越界："${p}" 解析到沙箱 ${path.resolve(sandbox)} 之外，已拒绝`);
    e.blocked = true;
    throw e;
  }
  return abs;
}

// 危险命令拦截表（尽力而为的拦截，不是完整沙箱；bash 内部命令仍可能触达沙箱外）
const DANGEROUS = [
  [/\brm\b[^|;&>]*\s-{1,2}[a-z-]*(r|f)/i, 'rm 递归/强制删除'],
  [/\b(del|rd|rmdir|erase)\b[^|;&>]*\/(s|f|q)\b/i, 'Windows 递归/强制删除'],
  [/\bformat\b/i, '格式化磁盘'],
  [/\bdiskpart\b/i, 'diskpart 磁盘操作'],
  [/\bmkfs/i, 'mkfs 格式化'],
  [/\bshutdown\b/i, '关机/重启'],
  [/\b(reg|regedit|regsvr32)\b/i, '注册表操作'],
  [/\bdd\b\s+if=/i, 'dd 磁盘写入'],
  [/>\s*(\/|~\/|[A-Za-z]:[\\/])/i, '输出重定向到沙箱外绝对路径'],
];

// ---------- 内置工具（仅供 agent 循环内部使用，不对外暴露为 MCP 工具） ----------

const TOOL_DEFS = [
  {
    name: 'read_file',
    description: '读取沙箱内一个文本文件（UTF-8）。文件过大或越界会被拒绝。',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: '沙箱内相对路径' } } },
    run(args, ctx) {
      const p = resolveInSandbox(ctx.sandbox, needStr(args.path, 'path'));
      const st = fs.statSync(p);
      if (st.isDirectory()) throw new Error(`"${args.path}" 是目录，请用 list_dir`);
      if (st.size > 2 * 1024 * 1024) throw new Error(`文件过大（${st.size} 字节），拒绝读取`);
      return cap(fs.readFileSync(p, 'utf8'), 12000);
    },
  },
  {
    name: 'write_file',
    description: '把文本写入沙箱内文件（自动创建父目录，覆盖已有内容）。',
    parameters: {
      type: 'object', required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    },
    run(args, ctx) {
      const p = resolveInSandbox(ctx.sandbox, needStr(args.path, 'path'));
      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
      if (content.length > 512 * 1024) throw new Error('content 超过 512KB，拒绝写入');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf8');
      return `已写入 ${path.relative(ctx.sandbox, p) || '.'}（${content.length} 字符）`;
    },
  },
  {
    name: 'list_dir',
    description: '列出沙箱内目录条目（目录在前）。path 缺省为沙箱根目录。',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    run(args, ctx) {
      const p = resolveInSandbox(ctx.sandbox, args.path ? needStr(args.path, 'path') : '.');
      const entries = fs.readdirSync(p, { withFileTypes: true })
        .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
      const note = entries.length > 500 ? `…(共 ${entries.length} 条，仅显示前 500)\n` : '';
      const lines = entries.slice(0, 500).map(e => `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}`);
      return note + (lines.length ? lines.join('\n') : '（空目录）');
    },
  },
  {
    name: 'grep',
    description: '在沙箱内用 JavaScript 正则搜索文件内容，返回 "文件:行号: 内容" 列表（跳过 node_modules/.git 与超大/二进制文件，最多 100 条）。path 缺省为沙箱根目录。',
    parameters: {
      type: 'object', required: ['pattern'],
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
    },
    run(args, ctx) {
      const base = resolveInSandbox(ctx.sandbox, args.path ? needStr(args.path, 'path') : '.');
      let re;
      try { re = new RegExp(needStr(args.pattern, 'pattern')); } catch (e) { throw new Error(`正则无效：${e.message}`); }
      const out = [];
      const skip = new Set(['node_modules', '.git']);
      const stack = [base];
      while (stack.length && out.length < 100) {
        const cur = stack.pop();
        let st; try { st = fs.statSync(cur); } catch { continue; }
        if (st.isDirectory()) {
          for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
            if (e.isDirectory() && skip.has(e.name)) continue;
            stack.push(path.join(cur, e.name));
          }
          continue;
        }
        if (st.size > 1024 * 1024) continue;
        let text; try { text = fs.readFileSync(cur, 'utf8'); } catch { continue; }
        if (text.slice(0, 1000).includes('\u0000')) continue; // 二进制
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && out.length < 100; i++) {
          if (re.test(lines[i])) out.push(`${path.relative(ctx.sandbox, cur) || '.'}:${i + 1}: ${cap(lines[i].trim(), 200)}`);
        }
      }
      return out.length ? out.join('\n') : '无匹配';
    },
  },
  {
    name: 'bash',
    description: '在沙箱目录内执行 shell 命令（默认 30 秒超时，输出截断；危险命令会被拦截；Windows 上走 cmd.exe）。',
    parameters: { type: 'object', required: ['command'], properties: { command: { type: 'string' } } },
    async run(args, ctx) {
      const command = needStr(args.command, 'command');
      if (!dangerousAllowed()) {
        for (const [re, why] of DANGEROUS) {
          if (re.test(command)) {
            const e = new Error(`已拦截危险命令（${why}）：${cap(command, 120)}。如确需执行，请设置环境变量 WORKFLOW_ALLOW_DANGEROUS=1`);
            e.blocked = true;
            throw e;
          }
        }
      }
      const remaining = Math.max(1000, ctx.deadline - Date.now());
      const timeout = Math.min(30000, remaining);
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)].filter(Boolean));
      const { err, stdout, stderr } = await new Promise(resolve => {
        exec(command, { cwd: ctx.sandbox, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal }, (e, so, se) => resolve({ err: e, stdout: so, stderr: se }));
      });
      const codeInfo = !err ? 'exit=0' : err.killed ? '（被中止/超时）' : `exit=${err.code ?? '?'}`;
      return `命令已执行 ${codeInfo}\n[stdout]\n${cap(stdout)}\n[stderr]\n${cap(stderr)}`;
    },
  },
  {
    name: 'fetch_url',
    description: '用 HTTP(S) GET/POST 抓取 URL，返回状态码与响应文本前 4000 字符。默认关闭，需要环境变量 WORKFLOW_ALLOW_NET=1。',
    parameters: {
      type: 'object', required: ['url'],
      properties: { url: { type: 'string' }, method: { type: 'string', description: '缺省 GET' } },
    },
    async run(args, ctx) {
      if (!netAllowed()) { const e = new Error('联网已关闭：fetch_url 需要环境变量 WORKFLOW_ALLOW_NET=1'); e.denied = true; throw e; }
      const url = needStr(args.url, 'url');
      if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http(s) URL');
      const method = String(args.method ?? 'GET').toUpperCase();
      const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15000)].filter(Boolean)) });
      return `HTTP ${res.status}\n${cap(await res.text(), 4000)}`;
    },
  },
];
const TOOL_MAP = Object.fromEntries(TOOL_DEFS.map(t => [t.name, t]));

async function runTool(tc, ctx) {
  const def = TOOL_MAP[tc.name];
  if (!def) return { ok: false, content: `错误：未知工具 "${tc.name}"（可用：${ctx.whitelist.join('、')}）` };
  if (!ctx.whitelist.includes(tc.name)) {
    return { ok: false, content: `错误：工具 "${tc.name}" 不在该步骤的白名单内（允许：${ctx.whitelist.join('、')}）`, denied: true };
  }
  let args = tc.args;
  if (args == null || typeof args !== 'object' || Array.isArray(args)) args = {};
  try {
    return { ok: true, content: String(await def.run(args, ctx)) };
  } catch (e) {
    return { ok: false, content: `错误：${e.message}`, blocked: Boolean(e.blocked), denied: Boolean(e.denied) };
  }
}

// ---------- agent 循环 ----------

export function resolveWhitelist(stepTools) {
  const envList = (process.env.WORKFLOW_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean);
  const base = envList.length ? envList : [...KNOWN_TOOLS];
  if (Array.isArray(stepTools) && stepTools.length) {
    const denied = stepTools.filter(t => !base.includes(t));
    if (denied.length) throw new Error(`步骤要求的工具超出允许范围：${denied.join('、')}（当前允许：${base.join('、')}；可用 WORKFLOW_TOOLS / WORKFLOW_ALLOW_NET 调整）`);
    return [...new Set(stepTools)];
  }
  return base;
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

// 多轮工具调用循环。返回 { text, json, turns, toolCalls, blocked, errors }。
// outputSchema 配置时：最终文本提取 JSON 并校验，不符则带着错误重试一轮，仍不符则抛错（步骤失败）。
export async function agentLoop({ prompt, system, model, timeoutMs = 120000, maxTurns = 8, tools, sandboxCwd, outputSchema = null, signal }) {
  const { baseUrl, apiKey, model: defaultModel } = llmConfig();
  if (!baseUrl || !apiKey) throw new Error('LLM 未配置（需要 LLM_BASE_URL 与 LLM_API_KEY）');
  const adapter = pickAdapter(baseUrl);
  const sandbox = path.resolve(sandboxCwd || process.cwd());
  fs.mkdirSync(sandbox, { recursive: true });
  const whitelist = resolveWhitelist(tools);
  const toolDefs = TOOL_DEFS.filter(t => whitelist.includes(t.name));
  const sys = system || buildSystem({ sandbox, toolNames: whitelist, outputSchema });
  const deadline = Date.now() + timeoutMs;
  const ctx = { sandbox, whitelist, deadline, signal };
  const transcript = [{ role: 'user', text: prompt }];
  const trace = { turns: 0, toolCalls: 0, blocked: [], errors: [] };
  let schemaCorrections = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    trace.turns = turn;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`步骤超时（预算 ${timeoutMs}ms 已用尽）`);
    const res = await fetch(adapter.chatUrl(baseUrl), {
      method: 'POST',
      headers: adapter.headers(apiKey),
      body: JSON.stringify(adapter.buildBody({ model: model || defaultModel, system: sys, messages: transcript, tools: toolDefs })),
      signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)].filter(Boolean)),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
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
    transcript.push({ role: 'user', text: `你的输出不符合要求的 JSON Schema：${problems.join('；')}。要求的 Schema：${JSON.stringify(outputSchema)}。请重新输出：只输出一个符合该 Schema 的 JSON，不要包含其他文字，也不要调用工具。` });
  }
  throw new Error(`达到 maxTurns=${maxTurns} 仍未产出最终结果（可调大 maxTurns，或在提示词里约束输出）`);
}

// 单轮补全（verify reviewer / final_verify 用），无工具
export async function simpleCompletion({ system, prompt, model, timeoutMs = 60000, signal }) {
  const { baseUrl, apiKey, model: defaultModel } = llmConfig();
  if (!baseUrl || !apiKey) throw new Error('LLM 未配置（需要 LLM_BASE_URL 与 LLM_API_KEY）');
  const adapter = pickAdapter(baseUrl);
  const res = await fetch(adapter.chatUrl(baseUrl), {
    method: 'POST',
    headers: adapter.headers(apiKey),
    body: JSON.stringify(adapter.buildBody({ model: model || defaultModel, system, messages: [{ role: 'user', text: prompt }], tools: [] })),
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  return adapter.parse(await res.json()).text;
}
