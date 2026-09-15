#!/usr/bin/env node
// workflow-mcp：确定性工作流 MCP 服务器（stdio 传输，零依赖，Node >= 20）
//
// 设计参考 AgentFlow（github.com/kanghelyu/agent-flow，MIT）的门控思想：
// 分支由布尔门表达式驱动，只在依赖落定后求值一次，结果恒定可续跑。
//
// 分层：server.mjs（协议层）→ lib/executor.mjs（编排）→ lib/store.mjs（持久化 + 工具）
//       → lib/{state,schema,planner,render}.mjs（状态机/结构/提示词/展示）
//       → lib/{agent,agent-tools,config}.mjs（LLM 循环、内置工具、配置）
import readline from 'node:readline';
import * as store from './lib/store.mjs';
import { runWorkflow, dispatchBatches, cancelRun } from './lib/executor.mjs';
import { configWarnings } from './lib/config.mjs';
import { withLock } from './lib/lock.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const SERVER_INFO = { name: 'workflow-mcp', version: '1.1.0' };

const INSTRUCTIONS = [
  '确定性工作流编排：DAG + 布尔门 + 断点续跑。',
  '手动循环：create_workflow → 循环 { next_step → 做事 → complete_step } → validate_workflow。',
  '自动执行：把步骤标记 mode="auto" 后调 run_workflow（配置 LLM_BASE_URL/LLM_API_KEY 时服务器内 agent 循环执行；未配置则返回派发批次，由宿主并行派子代理后 complete_step 回填）。',
  '每步可用 gate（如 "A && !B"，只允许引用直接依赖）控制分支：依赖落定后求值一次，为假则自动跳过。',
].join('\n');

// lock: true —— 该工具会改写某条流的状态，需按流 id 串行，避免与并发调用互相覆盖。
const TOOLS = [
  {
    name: 'create_workflow',
    description: '新建工作流。steps 为数组，每项 {id?, title, instruction?, dependsOn?, gate?, mode?, agentPrompt?, model?, timeoutMs?, maxRetries?, tools?, maxTurns?, outputSchema?, verify?, sandboxCwd?}；gate 是布尔表达式（支持 && || ! 和括号），只允许引用该步骤的直接依赖，依赖落定后求值为假则该步骤被自动跳过。mode=auto 的步骤可被 run_workflow 自动执行：每个 auto 步骤由服务器内 agent 循环驱动（多轮工具调用：读/写文件、列目录、grep、bash、fetch_url，全部限定在 sandboxCwd 沙箱内）；tools 为该步工具白名单，maxTurns 为循环轮数上限（默认取 WORKFLOW_MAX_TURNS，8），outputSchema 为结果 JSON Schema（不符自动重试一轮），verify 为完成后的质量关（JS 布尔断言或 reviewer 提示词），sandboxCwd 覆盖该步沙箱目录。顶层 finalVerify（提示词）在全部步骤落定后做整体一致性检查。创建时即做结构、环与 id 合法性校验。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '工作流名称（用于生成 id，非唯一）' },
        description: { type: 'string', description: '目标/总纲，一句话' },
        finalVerify: { type: 'string', description: '流程级整体一致性检查提示词；全部步骤落定后由模型审核，结论记入 flow.finalVerifyResult（不改步骤状态）' },
        steps: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '步骤唯一 id（中英文/数字/下划线/连字符），缺省为 step-01/02…' },
              title: { type: 'string', description: '步骤标题（必填）' },
              instruction: { type: 'string', description: '给执行者的具体说明' },
              dependsOn: { type: 'array', items: { type: 'string' }, description: '前置步骤 id 列表' },
              gate: { type: 'string', description: '门条件布尔表达式，如 "step-01 && !step-02"' },
              mode: { type: 'string', enum: ['manual', 'auto'], description: '执行方式：manual=人工做（缺省，等 complete_step），auto=可被 run_workflow 自动执行（agent 循环）' },
              agentPrompt: { type: 'string', description: 'auto 步骤执行时给 agent 的提示词；缺省用 instruction' },
              model: { type: 'string', description: 'auto 步骤覆盖的模型名（缺省用 LLM_MODEL 环境变量）' },
              timeoutMs: { type: 'number', description: 'auto 步骤整个 agent 循环的超时毫秒数（缺省取 WORKFLOW_STEP_TIMEOUT_MS，120000）' },
              maxRetries: { type: 'number', description: 'auto 步骤失败/质量关未过后的重试次数（缺省取 WORKFLOW_MAX_RETRIES，0 即只试 1 次）' },
              tools: { type: 'array', items: { type: 'string', enum: ['read_file', 'write_file', 'list_dir', 'grep', 'bash', 'fetch_url'] }, description: '该步允许的 agent 工具白名单；缺省为服务器级 WORKFLOW_TOOLS（缺省全部内置工具；fetch_url 还需 WORKFLOW_ALLOW_NET=1）' },
              maxTurns: { type: 'number', description: 'agent 循环最大轮数（缺省 8，1-64）' },
              outputSchema: { type: 'object', description: '期望结果的 JSON Schema（支持 type/required/properties/items/enum/const/minimum/maximum/minLength/maxLength/pattern/minItems/maxItems/additionalProperties）；输出不符会带错误重试一轮，仍不符则该步失败' },
              verify: { type: 'string', description: '完成后的质量关：JS 布尔断言（如 "n === 42"、"output.includes(\'报告\')"，作用在 result 字段上，配了 outputSchema 时字段直接可用）或 reviewer 提示词（调模型回 PASS/FAIL）；不通过则该步 failed（计入 maxRetries）' },
              sandboxCwd: { type: 'string', description: '该步 agent 允许访问的目录（相对服务器根目录；缺省取 WORKFLOW_SANDBOX，否则为服务器根目录）' },
            },
            required: ['title'],
          },
        },
      },
      required: ['name', 'steps'],
    },
    handler: store.createWorkflow,
  },
  {
    name: 'list_workflows',
    description: '列出全部工作流及各自进度（单个文件损坏时只标注该条，不影响整体列表）。',
    inputSchema: { type: 'object', properties: {} },
    handler: () => store.listWorkflows(),
  },
  {
    name: 'get_workflow',
    description: '读取工作流全文。format=json 返回结构化对象（含每步六态状态、结果与当前 ready 列表），format=md 额外返回人类可读的 WORKFLOW.md（含 mermaid 图）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        format: { type: 'string', enum: ['md', 'json'], description: '默认 md' },
      },
      required: ['id'],
    },
    handler: store.getWorkflow,
  },
  {
    name: 'next_step',
    description: '编译依赖图，返回当前可立即执行（READY）的步骤。这是执行循环的入口：next_step → 做事 → complete_step → 循环。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: store.nextStep,
  },
  {
    name: 'complete_step',
    description: '提交步骤结果并完成该步骤；Runtime 随即自动求值下游门条件（假则跳过），并返回新的 READY 步骤。result 建议传结构化 JSON（摘要、数字、产出物路径等）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        stepId: { type: 'string' },
        result: { description: '任意 JSON 结构，作为该步骤的结果存档' },
        notes: { type: 'string', description: '补充说明（可选）' },
      },
      required: ['id', 'stepId'],
    },
    handler: store.completeStep,
    lock: true,
  },
  {
    name: 'skip_step',
    description: '人工跳过某个未完成步骤（会触发下游门条件重算）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        stepId: { type: 'string' },
        reason: { type: 'string', description: '跳过原因，默认"人工跳过"' },
      },
      required: ['id', 'stepId'],
    },
    handler: store.skipStep,
    lock: true,
  },
  {
    name: 'undo_step',
    description: '撤销某步骤及其全部下游（传递依赖）的完成/跳过/失败状态与结果，用于返工。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, stepId: { type: 'string' } },
      required: ['id', 'stepId'],
    },
    handler: store.undoStep,
    lock: true,
  },
  {
    name: 'workflow_status',
    description: '进度总览：完成/跳过/失败/运行中/待办计数及每步一行状态。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: store.workflowStatus,
  },
  {
    name: 'validate_workflow',
    description: '确定性结构校验（不调用模型）：重复 id、非法 id 字符、悬空依赖、自依赖、门条件引用非直接依赖、依赖环。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: store.validateWorkflow,
  },
  {
    name: 'delete_workflow',
    description: '归档删除工作流（移入 trash 目录，可用 restore_workflow 恢复）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: store.deleteWorkflow,
    lock: true,
  },
  {
    name: 'list_trash',
    description: '列出归档删除（trash 目录）里的工作流，供恢复时挑选。',
    inputSchema: { type: 'object', properties: {} },
    handler: () => store.listTrash(),
  },
  {
    name: 'restore_workflow',
    description: '从归档（trash）恢复一条工作流。id 可以是原工作流 id（取最近一次删除）或 trash 里的文件名；目标 id 已存在时需 overwrite=true。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '原工作流 id 或 trash 文件名' },
        overwrite: { type: 'boolean', description: '目标 id 已存在时是否覆盖，默认 false' },
      },
      required: ['id'],
    },
    handler: store.restoreWorkflow,
    lock: true,
  },
  {
    name: 'run_workflow',
    description: '自动执行工作流：编译 READY 步骤，互不依赖的 auto 步骤批内并行、批间串行；跑完自动推进门条件，循环直到完成/卡住，全程可断点续跑（已 done 的步骤绝不重跑）。每个 auto 步骤由服务器内 agent 循环执行（多轮工具调用：读写文件/列目录/grep/bash/fetch_url，限定在沙箱内），之后过 outputSchema/verify 质量关；配了 finalVerify 且全部落定后做整体一致性检查。方案A（配置了 LLM_BASE_URL/LLM_API_KEY 时）直调 LLM API，支持 OpenAI 与 Anthropic 兼容端点（LLM_PROTOCOL 或按 URL 识别）；未配置密钥或 mode=dispatch 时自动退化为方案B（返回派发批次，由宿主并行执行后 complete_step 回填）。某步失败（含质量关未过）按 maxRetries 重试后仍失败则只标记该步 failed（视为落定、门条件中为 false），其余分支照常推进，不会整条流崩；manual 步骤不会被代跑，会提示待人工处理。同一条流同时只允许一个执行，运行中可用 cancel_run 打断。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        maxConcurrency: { type: 'number', description: '并行上限（默认取 LLM_MAX_CONCURRENCY 环境变量，缺省 4；硬上限 32）' },
        mode: { type: 'string', enum: ['auto', 'dispatch'], description: 'auto=强制方案A（需密钥）；dispatch=强制方案B；缺省=有密钥走A否则B' },
      },
      required: ['id'],
    },
    handler: runWorkflow,
    lock: true,
  },
  {
    name: 'dispatch_batches',
    description: '方案B入口：返回当前可并行的步骤批次 [{stepIds, prompts, upstreamResults}]（批内并行、批间串行，按"全部成功"投影分组）+ runtimeDefaults（服务器级默认模型/超时/轮数/工具），宿主 agent 拿批次并行派子代理执行，每个完成后用 complete_step 回填；若中途有失败/跳过导致门条件变化，重新调用本工具取新批次。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: dispatchBatches,
  },
  {
    name: 'cancel_run',
    description: '取消/打断当前 run_workflow 的自动执行：在途请求中止，运行中的步骤回到待办状态（续跑时会重新执行）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: cancelRun,
  },
];

// ---------- JSON-RPC 分发 ----------

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function dispatch(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return ok(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.has(requested) ? requested : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });

      case 'tools/call': {
        const name = params?.name;
        const tool = TOOLS.find(t => t.name === name);
        if (!tool) return ok(id, { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true });
        const args = params?.arguments ?? {};
        try {
          // 写类工具按流 id 串行：stdio 不会等上一条处理完就派发下一条，不串行会互相覆盖状态
          const invoke = () => tool.handler(args);
          const out = tool.lock && args.id ? await withLock(String(args.id), invoke) : await invoke();
          const text = out?.text ?? JSON.stringify(out, null, 2);
          return ok(id, { content: [{ type: 'text', text: String(text) }], structuredContent: out ?? undefined });
        } catch (e) {
          // 工具执行失败按 MCP 惯例作为 isError 结果返回，而不是协议错误
          return ok(id, { content: [{ type: 'text', text: `❌ ${e.message}` }], isError: true });
        }
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null; // 通知不回复
      default:
        if (isNotification) return null;
        return err(id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    if (isNotification) return null;
    return err(id, -32603, e.message);
  }
}

// ---------- stdio 主循环（每行一条 JSON-RPC 消息） ----------

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  const reply = await dispatch(msg);
  if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
});
rl.on('close', () => process.exit(0));

// 参数：--root <dir> 可改存储位置（默认服务器目录旁的 flows/）
const rootIdx = process.argv.indexOf('--root');
if (rootIdx !== -1 && process.argv[rootIdx + 1]) store.setRoot(process.argv[rootIdx + 1]);

// 启动期配置告警只写 stderr —— stdout 是 JSON-RPC 通道，写进去会污染协议
for (const w of configWarnings()) process.stderr.write(`[workflow-mcp] ${w}\n`);
