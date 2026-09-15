// 执行器：统一抽象两个方案，共用同一套 DAG/门/续跑状态（不另起状态机）。
//
// 方案A「自含执行器」：服务器进程内 agent 循环——每个 auto 步骤由多轮 LLM 工具调用
//   （read_file/write_file/list_dir/grep/bash/fetch_url，见 lib/agent-tools.mjs）驱动，
//   真读文件、跑命令、写文件，直到产出最终文本；之后过 verify / outputSchema 质量关。
//   环境变量见 lib/config.mjs 与 README。
//   未配置密钥时自动退化为方案B（零密钥、零网络）。
// 方案B「宿主驱动」：只产出派发批次（步骤分组 + 拼装好的提示词 + 上游结果），
//   宿主 agent 拿去并行派子代理执行，跑完逐个 complete_step 回填。
import vm from 'node:vm';
import { loadFlow, saveFlow, rootDir, registerLiveRun, unregisterLiveRun, stepById } from './store.mjs';
import { computeReady, evaluateGates, isFlowSettled } from './state.mjs';
import { buildPrompt, planBatches, resolveSandbox } from './planner.mjs';
import { agentLoop, simpleCompletion, cap } from './agent.mjs';
import { loadConfig, LIMITS } from './config.mjs';

const activeRuns = new Map(); // flowId -> { cancelled, controllers:Set<AbortController> }

export function isAutoConfigured() {
  return loadConfig().llm.configured;
}
export function isRunning(id) { return activeRuns.has(id); }

// ---------- 方案B：派发批次 ----------

export function dispatchBatches({ id }) {
  const flow = loadFlow(id);
  const { batches, manualReady, blocked } = planBatches(flow);
  const shaped = batches.map((b, i) => ({ batch: i + 1, stepIds: b.map(s => s.stepId), steps: b }));

  const head = shaped.length
    ? `派发批次（批内并行、批间串行，共 ${shaped.length} 批；批次是"全部成功"的投影，出现失败/跳过后请重新调用）：`
    : '当前没有可派发的 auto 步骤。';
  const body = shaped.map(b => {
    const items = b.steps.map(s => {
      const instr = s.prompt.split('\n').find(l => l.startsWith('【指令】')) ?? '';
      return `  - ${s.stepId}：${instr.replace('【指令】', '').slice(0, 200)}`;
    }).join('\n');
    return `\n【第 ${b.batch} 批】可并行：${b.stepIds.join(' + ')}\n${items}`;
  }).join('');
  const tail = manualReady.length ? `\n等待手动执行的 READY 步骤：${manualReady.join('、')}（用 next_step 查看 / complete_step 提交）` : '';
  const tail2 = blocked.length ? `\n被阻塞（依赖或门未落定）：${blocked.join('、')}` : '';

  const cfg = loadConfig();
  return {
    text: head + body + tail + tail2 + '\n\n执行方式：批内步骤可并行派子代理，各自完成后调 complete_step 回填结果，再取下一批。',
    batches: shaped,
    manualReady,
    blocked,
    runtimeDefaults: { ...cfg.stepDefaults, model: cfg.llm.model },
  };
}

// ---------- 方案A：步骤内 agent 循环 + 质量关 ----------

async function runAgentStep({ flow, step, signal }) {
  const runtime = {
    prompt: buildPrompt(flow, step),
    model: step.model || undefined,
    timeoutMs: step.timeoutMs ?? undefined,
    maxTurns: step.maxTurns ?? undefined,
    tools: step.tools ?? undefined,
    sandboxCwd: resolveSandbox(step, rootDir()),
    outputSchema: step.outputSchema ?? null,
    signal,
  };
  const out = await agentLoop(runtime);
  if (step.verify) out.verifyMode = await runVerify(step, out, signal);
  return out;
}

// ---------- verify 求值（安全沙箱） ----------

// 断言求值用 node:vm 的干净上下文：只注入 result 字段 + 白名单全局函数，
// process/globalThis/require/constructor/Function/eval 等一律不可达（黑名单先行拦截）。
// 注：node:vm 不是强安全边界（对抗性输入仍可通过混淆绕过黑名单逃逸），这里只防"误触"与常见直接逃逸；
// verify 由工作流作者自己编写，不接不受信输入。
const VERIFY_GLOBALS = {
  String, Number, Boolean, Array, Object, JSON, Math,
  parseInt, parseFloat, isNaN, isFinite, RegExp, Date, Infinity, NaN,
};
const VERIFY_FORBIDDEN = /\b(process|globalThis|global|require|module|exports|__dirname|__filename|constructor|__proto__|prototype|Function|eval|import|Buffer|setTimeout|setInterval|clearTimeout|clearInterval)\b/;

function evalVerifyAssertion(expr, fields) {
  const hit = expr.match(VERIFY_FORBIDDEN);
  if (hit) throw new Error(`verify 含禁用标识符 "${hit[0]}"（process/globalThis/require/constructor/Function/eval 等不可用）`);
  const context = Object.create(null);
  for (const [k, v] of Object.entries(VERIFY_GLOBALS)) context[k] = v;
  for (const [k, v] of Object.entries(fields)) context[k] = v;
  Object.freeze(context);
  return vm.runInNewContext(`(${expr})`, context, { timeout: 200 });
}

// verify：合法 JS 布尔表达式（作用在 result 字段上，配了 outputSchema 时字段直接可用）
// 或 reviewer 提示词（调一次模型判 PASS/FAIL）。不通过 → 抛错，按 maxRetries 重跑整步。
async function runVerify(step, out, signal) {
  const subject = {
    ...(out.json && typeof out.json === 'object' && !Array.isArray(out.json) ? out.json : {}),
    output: out.json ?? out.text,
    text: out.text,
  };
  let verdict;
  let evalError = null;
  // 含运算/调用/比较特征时才当作表达式求值；普通自然语言提示词直接走 reviewer，避免误报禁用标识符
  if (/[=<>!&|()[\]{}"'`0-9]/.test(step.verify)) {
    try {
      verdict = evalVerifyAssertion(step.verify, subject);
    } catch (e) {
      evalError = e;
    }
  }
  if (typeof verdict === 'boolean') {
    if (verdict) return 'assert';
    throw new Error(`verify 断言未通过："${step.verify}" 求值为 false；结果摘要：${cap(JSON.stringify({ output: out.json ?? out.text, text: out.text }), 300)}`);
  }
  // 明显是表达式却含禁用标识符：明确判失败，而不是降级成 reviewer 提示词
  if (evalError && /禁用标识符/.test(evalError.message)) throw evalError;

  // 不是布尔表达式（语法错/求值非布尔/普通提示词）→ 当作 reviewer 提示词，调模型审核
  const reply = await simpleCompletion({
    system: '你是严格的结果审核员：根据审核要求判断执行结果是否合格。只回答 PASS 或 FAIL：原因，不要输出其他内容。',
    prompt: `【步骤】${step.title}（id: ${step.id}）\n【审核要求】${step.verify}\n【执行结果】${JSON.stringify(out.json ?? out.text).slice(0, 4000)}`,
    model: step.model || undefined,
    signal,
  });
  if (/\bPASS\b/i.test(reply) && !/\bFAIL\b/i.test(reply)) return 'reviewer';
  throw new Error(`verify 审核未通过：${cap(reply, 300)}`);
}

// ---------- 并发池 ----------

async function runPool(items, limit, worker) {
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) await worker(items[cursor++]);
  });
  await Promise.all(lanes);
}

function summarize(flow, extra = '') {
  const by = st => flow.steps.filter(s => s.status === st);
  const failed = by('failed');
  const manualReady = computeReady(flow).filter(s => s.mode === 'manual').map(s => s.id);
  const lines = [
    `执行摘要：完成 ${by('done').length}/${flow.steps.length}，跳过 ${by('skipped').length}，失败 ${failed.length}，运行中 ${by('running').length}。${extra}`,
    failed.length ? `失败步骤：\n${failed.map(s => `  ❌ ${s.id}（${s.title}）：${s.failureReason}，已尝试 ${s.attempts} 次`).join('\n')}` : '',
    by('running').length ? `仍在运行（下次 run_workflow 会续跑）：${by('running').map(s => s.id).join('、')}` : '',
    manualReady.length ? `待人工处理（run_workflow 不会代跑 manual 步骤）：${manualReady.join('、')}（用 next_step 查看 / complete_step 提交）` : '',
  ];
  const counts = { done: by('done').length, skipped: by('skipped').length, failed: failed.length, running: by('running').length, total: flow.steps.length };
  return { text: lines.filter(Boolean).join('\n'), counts, failedSteps: failed.map(s => ({ id: s.id, title: s.title, reason: s.failureReason, attempts: s.attempts })), manualReady };
}

// ---------- run_workflow 主循环 ----------

export async function runWorkflow({ id, maxConcurrency, mode } = {}) {
  const cfg = loadConfig();
  const wantAuto = mode !== 'dispatch' && (mode === 'auto' || isAutoConfigured());

  if (!wantAuto) {
    if (mode === 'auto' && !isAutoConfigured()) {
      const d = dispatchBatches({ id });
      return { text: '⚠️ 未配置 LLM_BASE_URL / LLM_API_KEY，方案A 不可用；已退化为方案B派发模式。\n\n' + d.text, dispatched: true, batches: d.batches, manualReady: d.manualReady, blocked: d.blocked };
    }
    const d = dispatchBatches({ id });
    return { text: d.text, dispatched: true, batches: d.batches, manualReady: d.manualReady, blocked: d.blocked };
  }

  // 同一条流不允许两个 run 并存：否则两边各持一份快照回填，结果会互相覆盖。
  if (activeRuns.has(id)) {
    return {
      text: `⚠️ 工作流 "${id}" 已有一个自动执行正在进行：请等它结束，或先 cancel_run 打断后再续跑。`,
      dispatched: false, busy: true,
    };
  }

  const limit = Math.max(1, Math.min(Math.trunc(Number(maxConcurrency) || cfg.llm.maxConcurrency), LIMITS.maxConcurrency));
  const run = { cancelled: false, controllers: new Set() };
  activeRuns.set(id, run);
  // 必须在任何 loadFlow 之前登记：否则会被当成"崩溃残留"把这些步骤退回 pending
  registerLiveRun(id);

  let cancelled = false;
  try {
    const initial = loadFlow(id);
    for (let guard = 0; guard <= initial.steps.length + 1; guard++) {
      const flow = loadFlow(id);
      const batch = computeReady(flow).filter(s => s.mode === 'auto');
      if (run.cancelled || !batch.length) break;

      for (const s of batch) { s.status = 'running'; s.attempts = 0; }
      saveFlow(flow);

      const outcomes = new Map(); // stepId -> { ok, out?, error?, attempts, cancelled? }
      const flowAtStart = flow;   // 批内上游已落定，快照足够拼提示词
      await runPool(batch, limit, async (step) => {
        const maxAttempts = 1 + (step.maxRetries ?? cfg.stepDefaults.maxRetries);
        let lastErr = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (run.cancelled) break;
          const ctrl = new AbortController();
          run.controllers.add(ctrl);
          try {
            const out = await runAgentStep({ flow: flowAtStart, step, signal: ctrl.signal });
            outcomes.set(step.id, { ok: true, out, attempts: attempt });
            return;
          } catch (e) {
            lastErr = (e?.name === 'TimeoutError' || e?.name === 'AbortError')
              ? `超时/中止（${step.timeoutMs ?? cfg.stepDefaults.timeoutMs}ms）`
              : e.message;
          } finally {
            run.controllers.delete(ctrl);
          }
        }
        outcomes.set(step.id, { ok: false, error: lastErr || '已取消', attempts: maxAttempts, cancelled: run.cancelled });
      });

      if (run.cancelled) cancelled = true;

      // 回填结果（同一份 flow 上推进门条件，串行无竞态）
      const after = loadFlow(id);
      for (const step of batch) {
        const s = stepById(after, step.id);
        const out = outcomes.get(step.id);
        if (!s || !out) { if (s && s.status === 'running') s.status = 'pending'; continue; }
        if (out.ok) {
          s.status = 'done';
          s.result = shapeResult(out.out);
          s.failureReason = null;
          s.skipReason = null;
          s.completedAt = new Date().toISOString();
        } else if (out.cancelled) {
          s.status = 'pending'; // 取消的步骤回到待办，续跑时重跑
          s.failureReason = null;
        } else {
          s.status = 'failed';
          s.failureReason = out.error;
          s.attempts = out.attempts;
        }
      }
      evaluateGates(after);
      saveFlow(after);
      if (run.cancelled) break;
    }

    const flow = loadFlow(id);
    const finalVerifyNote = await maybeFinalVerify(flow, run, cfg);
    const s = summarize(flow, (cancelled ? '本次被 cancel_run 打断；' : '') + finalVerifyNote);
    return { text: s.text, dispatched: false, cancelled, ...s.counts, failedSteps: s.failedSteps, manualReady: s.manualReady };
  } finally {
    activeRuns.delete(id);
    unregisterLiveRun(id);
  }
}

// 统一 out → result 的形状：outputSchema 解析出的字段平铺，原始文本进 output，执行元数据进 _meta
function shapeResult(out) {
  const json = out.json;
  const meta = { attempts: out.attempts, turns: out.turns ?? 0, toolCalls: out.toolCalls ?? 0 };
  if (out.blocked?.length) meta.blocked = out.blocked.slice(0, 10);
  if (out.errors?.length) meta.errors = out.errors.slice(0, 10);
  if (out.verifyMode) meta.verify = out.verifyMode;
  return {
    ...(json && typeof json === 'object' && !Array.isArray(json) ? json : {}),
    output: json ?? cap(String(out.text ?? ''), 8000),
    _meta: meta,
  };
}

// 流程级 final_verify：全部落定后把汇总结果交给模型做整体一致性检查（只记录结论，不改状态）
async function maybeFinalVerify(flow, run, cfg) {
  if (!flow.finalVerify || run.cancelled || !isFlowSettled(flow) || !isAutoConfigured()) return '';
  try {
    const summary = flow.steps.map(s =>
      `- ${s.id}（${s.title}）[${s.status}]：${s.result ? JSON.stringify(s.result).slice(0, 500) : s.failureReason || ''}`
    ).join('\n');
    const reply = await simpleCompletion({
      system: '你是工作流的整体审核员：根据检查要求判断整条工作流的各步骤结果是否一致合格。只回答 PASS 或 FAIL：原因，不要输出其他内容。',
      prompt: `【工作流】${flow.name}${flow.description ? ` — ${flow.description}` : ''}\n【检查要求】${flow.finalVerify}\n【各步骤结果】\n${summary}`,
      timeoutMs: cfg.verify.timeoutMs,
    });
    const pass = /\bPASS\b/i.test(reply) && !/\bFAIL\b/i.test(reply);
    flow.finalVerifyResult = { pass, reply: cap(reply, 1000), at: new Date().toISOString() };
    saveFlow(flow);
    return pass ? '\n🔍 final_verify：通过' : `\n🔍 final_verify：未通过 — ${cap(reply, 200)}`;
  } catch (e) {
    return `\n🔍 final_verify 调用失败：${e.message}`;
  }
}

export function cancelRun({ id }) {
  const run = activeRuns.get(id);
  if (!run) {
    return { text: `ℹ️ 工作流 "${id}" 当前没有进行中的自动执行。（若上次进程中断留下 running 状态，直接再跑 run_workflow 即可续跑）` };
  }
  run.cancelled = true;
  for (const c of run.controllers) c.abort();
  return { text: `🛑 已请求取消 "${id}" 的当前执行：在途请求已中止，运行中的步骤将回到待办。` };
}
