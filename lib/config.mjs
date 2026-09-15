// 配置中心：所有环境变量的默认值、合法区间与启动期告警只在这里维护。
//
// 之前 LLM_* / WORKFLOW_* 的默认值散落在 agent.mjs（maxTurns=8、timeoutMs=120000…）
// 与 executor.mjs（重试默认 0、并发上限 32…）里各写一份，改一处容易漏一处。
// 现在统一走 loadConfig()：其余模块只消费结果，不再自己解析 process.env。
//
// 依赖方向：config.mjs → agent-tools.mjs（只为取工具名清单）。
// agent-tools.mjs 自己不读配置（安全开关由调用方通过 ctx 注入），因此不构成循环。
import { KNOWN_TOOLS } from './agent-tools.mjs';

// 硬上限：无论环境变量怎么配都不会越界，避免把服务器/宿主拖垮。
export const LIMITS = Object.freeze({
  maxConcurrency: 32,                     // 批内并行上限
  maxTurns: 64,                           // 单步 agent 循环轮数上限
  maxRetries: 10,                         // 单步重试次数上限
  minTimeoutMs: 1000,                     // 超时下限
  maxTimeoutMs: 24 * 60 * 60 * 1000,      // 超时上限：24h
});

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function int(v, def, min, max) {
  return Math.min(max, Math.max(min, Math.trunc(num(v, def))));
}
function bool(v) {
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
function csv(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}
function str(v) {
  return String(v ?? '').trim();
}

let cached = null;

// 读取并冻结配置。进程内 env 不会变，故只解析一次。
export function loadConfig() {
  if (cached) return cached;

  const baseUrl = str(process.env.LLM_BASE_URL).replace(/\/+$/, '');
  const apiKey = str(process.env.LLM_API_KEY);
  const protocolRaw = str(process.env.LLM_PROTOCOL).toLowerCase();
  const protocol = protocolRaw === 'anthropic' || protocolRaw === 'openai'
    ? protocolRaw
    : (/anthropic/i.test(baseUrl) ? 'anthropic' : 'openai');

  const pickTools = csv(process.env.WORKFLOW_TOOLS);
  const sandbox = str(process.env.WORKFLOW_SANDBOX);

  cached = Object.freeze({
    llm: Object.freeze({
      baseUrl,
      apiKey,
      configured: Boolean(baseUrl && apiKey),
      model: str(process.env.LLM_MODEL),
      protocol,
      maxConcurrency: int(process.env.LLM_MAX_CONCURRENCY, 4, 1, LIMITS.maxConcurrency),
      maxTokens: int(process.env.LLM_MAX_TOKENS, 4096, 256, 200000),
      // 未显式配置 temperature 时不发送，交给端点自己的默认值
      temperature: str(process.env.LLM_TEMPERATURE) === ''
        ? null
        : Math.min(2, Math.max(0, num(process.env.LLM_TEMPERATURE, 1))),
    }),
    security: Object.freeze({
      allowNet: bool(process.env.WORKFLOW_ALLOW_NET),
      allowDangerous: bool(process.env.WORKFLOW_ALLOW_DANGEROUS),
    }),
    // 步骤未显式配置时的服务器级默认值
    stepDefaults: Object.freeze({
      maxTurns: int(process.env.WORKFLOW_MAX_TURNS, 8, 1, LIMITS.maxTurns),
      timeoutMs: int(process.env.WORKFLOW_STEP_TIMEOUT_MS, 120000, LIMITS.minTimeoutMs, LIMITS.maxTimeoutMs),
      maxRetries: int(process.env.WORKFLOW_MAX_RETRIES, 0, 0, LIMITS.maxRetries),
      sandboxCwd: sandbox || null,
      tools: pickTools.length ? pickTools : [...KNOWN_TOOLS],
    }),
    verify: Object.freeze({
      timeoutMs: int(process.env.WORKFLOW_VERIFY_TIMEOUT_MS, 60000, LIMITS.minTimeoutMs, LIMITS.maxTimeoutMs),
    }),
  });
  return cached;
}

// 启动期配置告警文字（由 server.mjs 写到 stderr，绝不污染 stdout 的 JSON-RPC 通道）。
export function configWarnings() {
  const c = loadConfig();
  const out = [];
  if (c.llm.baseUrl && !c.llm.apiKey) out.push('已设置 LLM_BASE_URL 但缺少 LLM_API_KEY：run_workflow 将退化为方案B（派发）模式。');
  if (!c.llm.baseUrl && c.llm.apiKey) out.push('已设置 LLM_API_KEY 但缺少 LLM_BASE_URL：run_workflow 将退化为方案B（派发）模式。');
  if (c.llm.configured && !c.llm.model) out.push('未设置 LLM_MODEL：请求不指定模型，请确认端点存在默认模型。');
  const unknown = c.stepDefaults.tools.filter(t => !KNOWN_TOOLS.includes(t));
  if (unknown.length) out.push(`WORKFLOW_TOOLS 含未知工具：${unknown.join('、')}，这些名字会被拒绝。`);
  return out;
}
