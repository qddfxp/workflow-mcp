#!/usr/bin/env node
// workflow-mcp 命令行调用器 —— 把 MCP 工具当成普通命令来跑。
//
// 用法：
//   node call.mjs --list                              列出全部工具
//   node call.mjs list_workflows                      调用工具（无参数）
//   node call.mjs create_workflow '{"name":"x",...}'  传 JSON 参数
//   node call.mjs --root <dir> ...                    指定存储目录（默认服务器目录旁 flows/）
//   node call.mjs --json ...                          打印完整 JSON 响应而非人类文本
//
// 环境变量：
//   默认从 ~/.workbuddy/mcp.json 里对应服务器的 env 块载入，这样命令行测得的行为
//   与宿主加载时一致 —— 否则服务器看不到 LLM_* 就会静默退化成方案B派发，容易误判。
//   --env-file <file> 换一个来源；--no-env 完全不载入（只继承当前 shell）。
//   载入提示走 stderr，stdout 保持干净，便于 `| node` 管道消费。
//
// 退出码：0 = 成功；1 = 工具返回 isError；2 = 用法/协议/超时错误
//
// 底层就是 spawn server.mjs + stdio + JSON-RPC，与 test/ 下各测试同一条链路。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');
const DEFAULT_ENV_FILE = path.join(os.homedir(), '.workbuddy', 'mcp.json');

const USAGE = `用法：
  node call.mjs [--root <dir>] [--json] [--env-file <f>|--no-env] <tool> [jsonArgs]
  node call.mjs --list

选项：
  --root <dir>     指定工作流存储目录（默认服务器目录旁的 flows/）
  --json           打印完整 JSON 响应，而不是提炼后的人类文本
  --env-file <f>   从该 JSON 文件载入环境变量（默认 ~/.workbuddy/mcp.json）
  --no-env         不载入任何外部 env，只继承当前 shell
  --list           列出全部工具名与说明
  -h, --help       显示本帮助

示例：
  node call.mjs --list
  node call.mjs list_workflows
  node call.mjs create_workflow '{"name":"发布","steps":[{"id":"A","title":"准备"}]}'
  node call.mjs next_step '{"id":"发布-ab12"}'
  node call.mjs run_workflow '{"id":"发布-ab12"}'          # 配了 LLM_* 就走方案A
  node call.mjs --no-env list_workflows                    # 强制不带 LLM 密钥`;

// ---- 解析参数（取值型选项先把值摘掉，避免与工具名混淆）----
const argv = process.argv.slice(2);
function takeOpt(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1] ?? null;
  argv.splice(i, 2);
  return v;
}
function takeFlag(name) {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}

const ROOT = takeOpt('--root');
const ENV_FILE = takeOpt('--env-file');
const AS_JSON = takeFlag('--json');
const NO_ENV = takeFlag('--no-env');

if (takeFlag('-h') || takeFlag('--help') || argv.length === 0) {
  console.log(USAGE);
  process.exit(argv.length === 0 ? 2 : 0);
}

// ---- 载入 env：让命令行与宿主行为一致 ----
function loadEnvBlock(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (j && typeof j === 'object' && j.mcpServers) {
    const entries = Object.entries(j.mcpServers);
    // 优先挑 args 指向 server.mjs 的那个，否则退回第一个
    const hit = entries.find(([, v]) => (v?.args || []).some((a) => String(a).includes('server.mjs'))) || entries[0];
    return hit?.[1]?.env ?? {};
  }
  return j && typeof j === 'object' ? j : {};
}

let childEnv = process.env;
if (!NO_ENV) {
  const file = ENV_FILE || DEFAULT_ENV_FILE;
  const block = loadEnvBlock(file);
  if (block === null) {
    if (ENV_FILE) console.error(`[call.mjs] 无法读取 env 文件：${file}`);
  } else {
    const filled = Object.entries(block).filter(([, v]) => String(v ?? '').trim() !== '');
    if (filled.length) {
      childEnv = { ...process.env, ...Object.fromEntries(filled) };
      console.error(`[call.mjs] 已从 ${file} 载入 ${filled.length} 个环境变量：${filled.map(([k]) => k).join(', ')}`);
    }
  }
}

const serverArgs = [SERVER];
if (ROOT) serverArgs.push('--root', ROOT);

const proc = spawn(process.execPath, serverArgs, { stdio: ['pipe', 'pipe', 'inherit'], env: childEnv });
let buf = '';
const pending = new Map();
let nextId = 1;

proc.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});

function rpc(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`超时：${method}（${timeoutMs}ms）`)); }
    }, timeoutMs);
  });
}

function die(msg, code = 2) {
  console.error(msg);
  try { proc.stdin.end(); } catch {}
  process.exit(code);
}

// 1) 握手
const init = await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'call.mjs', version: '1.1.0' },
});
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

// 2) --list
if (argv[0] === '--list') {
  const tl = await rpc('tools/list', {});
  console.log(`${init.result.serverInfo.name} v${init.result.serverInfo.version} — ${tl.result.tools.length} 个工具\n`);
  for (const t of tl.result.tools) {
    console.log(`  ${t.name.padEnd(20)} ${(t.description || '').split('\n')[0]}`);
  }
  proc.stdin.end();
  await new Promise((r) => proc.on('exit', r));
  process.exit(0);
}

// 3) 解析工具名与参数
const [tool, rawArgs] = argv;
let toolArgs = {};
if (rawArgs !== undefined) {
  try {
    toolArgs = JSON.parse(rawArgs);
  } catch (e) {
    die(`jsonArgs 不是合法 JSON：${e.message}\n\n收到：${rawArgs}`);
  }
}

// 4) 调用；run_workflow 可能长时间运行，给它更宽的窗口
const timeoutMs = tool === 'run_workflow' ? 30 * 60 * 1000 : 60000;
let res;
try {
  res = await rpc('tools/call', { name: tool, arguments: toolArgs }, timeoutMs);
} catch (e) {
  die(String(e.message || e));
}

proc.stdin.end();
await new Promise((r) => proc.on('exit', r));

if (res.error) die(`协议错误：${JSON.stringify(res.error)}`);

const r = res.result;
if (AS_JSON) {
  console.log(JSON.stringify(r, null, 2));
} else {
  for (const c of r.content || []) {
    if (c.type === 'text') console.log(c.text);
    else console.log(JSON.stringify(c));
  }
}
process.exit(r.isError ? 1 : 0);
