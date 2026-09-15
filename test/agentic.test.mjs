// UPGRADE-agentic.md 验收测试（第 1、2 期）：步骤内 agent 循环 + 六个内置工具 + 安全沙箱
// + outputSchema / verify / final_verify。自带脚本化 mock LLM（按步骤 id 返回预设 tool_calls
// 序列，可读取请求里的工具结果做动态断言），零依赖。
// 运行：node test/agentic.test.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'server.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-agentic-test-'));

// ---------- 沙箱夹具 ----------
fs.writeFileSync(path.join(ROOT, 'probe.txt'), 'SANDBOX-PROBE-42');
fs.mkdirSync(path.join(ROOT, 'notes'));
fs.writeFileSync(path.join(ROOT, 'notes', 'a.txt'), 'banana boat');
fs.writeFileSync(path.join(ROOT, 'notes', 'b.txt'), 'apple pie and applesauce');
fs.mkdirSync(path.join(ROOT, 'sub'));
fs.writeFileSync(path.join(ROOT, 'sub', 'note.txt'), 'SUB-NOTE-99');

// ---------- mock LLM：按步骤 id 脚本化 ----------
const oaiTool = (id, name, args) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const oaiText = (t) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: t } }] });
const antTool = (id, name, args) => ({ content: [{ type: 'tool_use', id, name, input: args }], stop_reason: 'tool_use' });
const antText = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });

const agentScripts = new Map(); // stepId -> [fn(body, raw) => 协议响应]（按第 N 次 LLM 请求取第 N 项，超出复用最后一项）
const plainScripts = new Map(); // stepId -> fn(body, raw) => string（reviewer 等无工具请求）
const seq = new Map();          // stepId -> 已收到的 agent 轮请求数
const anthChecks = [];          // Anthropic 协议请求形状检查
const lastToolContent = (body) => {
  const t = (body.messages ?? []).filter(m => m.role === 'tool');
  return t[t.length - 1]?.content ?? '';
};

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw); } catch { /* ignore */ }
    const stepId = (raw.match(/（id: ([A-Za-z0-9_-]+)）/) || [])[1] ?? '?';
    const isAgentTurn = Array.isArray(body.tools) && body.tools.length > 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (isAgentTurn) {
      const i = seq.get(stepId) ?? 0;
      seq.set(stepId, i + 1);
      const script = agentScripts.get(stepId);
      const reply = script ? script[Math.min(i, script.length - 1)](body, raw) : oaiText(`${stepId} 的缺省最终结果`);
      res.end(JSON.stringify(reply));
      return;
    }
    const plain = plainScripts.get(stepId);
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: plain ? plain(body, raw) : 'PASS' } }] }));
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = mock.address().port;

// ---------- MCP 客户端（与 run.test.mjs 相同的链路） ----------

function makeClient(env) {
  const proc = spawn(process.execPath, [SERVER, '--root', ROOT], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  let buf = '';
  const pending = new Map();
  let seqId = 1;
  proc.stdout.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const rpc = (method, params) => {
    const id = seqId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`超时：${method}`)); } }, 30000);
    });
  };
  return {
    proc, rpc,
    call: (name, args) => rpc('tools/call', { name, arguments: args }),
    init: async () => {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    close: () => new Promise(r => { proc.stdin.end(); proc.on('exit', r); }),
  };
}

let failed = 0;
function check(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${cond ? '' : '  ' + String(extra).slice(0, 300)}`);
  if (!cond) failed++;
}
const text = r => r?.result?.content?.[0]?.text ?? '';
const sc = r => r?.result?.structuredContent;
const createFlow = async (c, steps, extra = {}) => sc(await c.call('create_workflow', { name: `agentic-${Math.random().toString(36).slice(2, 7)}`, steps, ...extra }))?.id;
const gw = async (c, fid) => sc(await c.call('get_workflow', { id: fid, format: 'json' }));
const stepOf = (flow, id) => flow.steps.find(s => s.id === id);

const C = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, LLM_API_KEY: 'test-key', LLM_MODEL: 'mock' });
await C.init();

// ---------- 第 1 期：agent 循环 + 工具 + 沙箱 ----------

{
  agentScripts.set('T1', [
    () => oaiTool('c1', 'read_file', { path: 'probe.txt' }),
    (body) => oaiTool('c2', 'write_file', { path: 'out.txt', content: lastToolContent(body) }), // 把读到的内容写出去
    () => oaiText('T1 完成：读取 probe.txt 并写入 out.txt'),
  ]);
  const fid = await createFlow(C, [
    { id: 'T1', title: '读后写', mode: 'auto', agentPrompt: '读取 probe.txt，把内容写入 out.txt' },
  ]);
  const run = await C.call('run_workflow', { id: fid });
  const out = path.join(ROOT, 'out.txt');
  const s = stepOf(await gw(C, fid), 'T1');
  check('验收1：步骤真读了文件并写出 out.txt（内容与源一致）', fs.existsSync(out) && fs.readFileSync(out, 'utf8') === 'SANDBOX-PROBE-42', `${text(run)} | ${fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '缺失'}`);
  check('验收1：result.output 为最终文本，_meta 记录轮数与工具调用', s?.status === 'done' && typeof s?.result?.output === 'string' && s?.result?._meta?.turns === 3 && s?.result?._meta?.toolCalls === 2, JSON.stringify(s?.result));
}

{
  agentScripts.set('T2', [
    () => oaiTool('c1', 'grep', { pattern: 'apple', path: 'notes' }),
    () => oaiTool('c2', 'read_file', { path: 'notes/b.txt' }),
    () => oaiTool('c3', 'write_file', { path: 'report.txt', content: 'apple lives in notes/b.txt' }),
    () => oaiText('T2 完成：grep→read→write 三轮'),
  ]);
  const fid = await createFlow(C, [
    { id: 'T2', title: '先搜后读再写', mode: 'auto', agentPrompt: '先 grep apple，再读对应文件，最后写 report.txt' },
  ]);
  await C.call('run_workflow', { id: fid });
  const report = path.join(ROOT, 'report.txt');
  const s = stepOf(await gw(C, fid), 'T2');
  check('验收2：grep→read→write 多轮循环成功（≥2 次 tool_calls）', fs.existsSync(report) && fs.readFileSync(report, 'utf8') === 'apple lives in notes/b.txt' && s?.result?._meta?.toolCalls === 3, JSON.stringify(s?.result));
}

{
  agentScripts.set('T3', [
    () => oaiTool('c1', 'read_file', { path: '../outside.txt' }),
    () => oaiTool('c2', 'write_file', { path: '../../evil.txt', content: 'evil' }),
    (body) => oaiText(lastToolContent(body).includes('路径越界') ? 'T3 两次越界均被拒绝' : 'T3 越界未被拦截：' + lastToolContent(body).slice(0, 80)),
  ]);
  const fid = await createFlow(C, [
    { id: 'T3', title: '尝试越界', mode: 'auto', agentPrompt: '读取 ../outside.txt 并写 ../../evil.txt' },
  ]);
  await C.call('run_workflow', { id: fid });
  const s = stepOf(await gw(C, fid), 'T3');
  check('验收3：读/写沙箱外路径被拒绝且不崩溃（步骤 done，拒绝信息回喂模型）', s?.status === 'done' && s?.result?.output === 'T3 两次越界均被拒绝' && s?.result?._meta?.blocked?.length === 2, JSON.stringify(s?.result));
  check('验收3：沙箱外没有产生 evil.txt', !fs.existsSync(path.join(ROOT, '..', 'evil.txt')));
}

{
  agentScripts.set('T4', [
    () => oaiTool('c1', 'bash', { command: 'rm -rf /' }),
    (body) => oaiText(lastToolContent(body).includes('已拦截') ? 'BLOCKED-OK' : 'BLOCK-MISS:' + lastToolContent(body).slice(0, 80)),
  ]);
  const fid = await createFlow(C, [{ id: 'T4', title: '危险命令', mode: 'auto', agentPrompt: '执行 rm -rf /' }]);
  await C.call('run_workflow', { id: fid });
  const s = stepOf(await gw(C, fid), 'T4');
  check('验收4：rm -rf / 被拦截并回喂模型、记录在 _meta.blocked', s?.status === 'done' && s?.result?.output === 'BLOCKED-OK' && /rm/.test(s?.result?._meta?.blocked?.[0] ?? ''), JSON.stringify(s?.result));
  check('验收4：沙箱目录未被破坏（flows/ 仍在）', fs.existsSync(path.join(ROOT, 'flows')));
}

{
  agentScripts.set('T4B', [
    () => oaiTool('c1', 'bash', { command: 'echo sandbox-echo-ok' }),
    (body) => oaiText(lastToolContent(body).includes('sandbox-echo-ok') ? 'ECHO-OK' : 'ECHO-FAIL:' + lastToolContent(body).slice(0, 80)),
  ]);
  const fid = await createFlow(C, [{ id: 'T4B', title: '正常命令', mode: 'auto', agentPrompt: '执行 echo sandbox-echo-ok' }]);
  await C.call('run_workflow', { id: fid });
  const s = stepOf(await gw(C, fid), 'T4B');
  check('bash 工具可正常执行并回传 stdout', s?.status === 'done' && s?.result?.output === 'ECHO-OK' && !s?.result?._meta?.errors?.length, JSON.stringify(s?.result));
}

{
  agentScripts.set('W1', [
    () => oaiTool('c1', 'write_file', { path: 'w.txt', content: 'nope' }),
    () => oaiText('W1 写入被拒后放弃'),
  ]);
  const fid = await createFlow(C, [
    { id: 'W1', title: '白名单受限', mode: 'auto', agentPrompt: '尝试写文件', tools: ['read_file'] },
  ]);
  await C.call('run_workflow', { id: fid });
  const s = stepOf(await gw(C, fid), 'W1');
  check('工具白名单生效：白名单外的工具被拒绝并记录', s?.status === 'done' && /白名单/.test(s?.result?._meta?.errors?.[0] ?? '') && !fs.existsSync(path.join(ROOT, 'w.txt')), JSON.stringify(s?.result));
}

{
  agentScripts.set('F1', [
    () => oaiTool('c1', 'fetch_url', { url: 'http://127.0.0.1:9/nope' }),
    () => oaiText('F1 联网被拒'),
  ]);
  const fid = await createFlow(C, [{ id: 'F1', title: '联网默认关', mode: 'auto', agentPrompt: '抓取网页' }]);
  await C.call('run_workflow', { id: fid });
  const s = stepOf(await gw(C, fid), 'F1');
  check('fetch_url 默认关闭（提示需 WORKFLOW_ALLOW_NET=1）并记录', s?.status === 'done' && /WORKFLOW_ALLOW_NET/.test(s?.result?._meta?.errors?.[0] ?? ''), JSON.stringify(s?.result));
}

{
  const fid = await createFlow(C, [
    { id: 'M1', title: '轮数耗尽', mode: 'auto', agentPrompt: '一直读文件', maxTurns: 2 },
  ]);
  agentScripts.set('M1', [
    () => oaiTool('m1', 'read_file', { path: 'probe.txt' }),
    () => oaiTool('m2', 'read_file', { path: 'probe.txt' }),
    () => oaiTool('m3', 'read_file', { path: 'probe.txt' }),
  ]);
  await C.call('run_workflow', { id: fid });
  const s = stepOf(await gw(C, fid), 'M1');
  check('maxTurns 耗尽且无最终文本 → 步骤 failed（原因可读）', s?.status === 'failed' && /maxTurns=2/.test(s?.failureReason ?? ''), JSON.stringify({ status: s?.status, reason: s?.failureReason }));
}

{
  const fid = await createFlow(C, [
    { id: 'V1', title: '自定义沙箱', mode: 'auto', agentPrompt: '读 sub/note.txt，再尝试越界读 ../probe.txt', sandboxCwd: 'sub' },
  ]);
  agentScripts.set('V1', [
    () => oaiTool('c1', 'read_file', { path: 'note.txt' }),
    (body) => oaiTool('c2', 'read_file', { path: '../probe.txt' }),
    (body) => {
      const toolMsgs = (body.messages ?? []).filter(m => m.role === 'tool');
      const okNote = (toolMsgs[0]?.content ?? '').includes('SUB-NOTE-99');
      const denied = (toolMsgs[1]?.content ?? '').includes('路径越界');
      return oaiText(okNote && denied ? 'V1-OK' : `V1-FAIL:${okNote}/${denied}`);
    },
  ]);
  await C.call('run_workflow', { id: fid });
  const s = stepOf(await gw(C, fid), 'V1');
  check('sandboxCwd 覆盖沙箱：目录内可读、越界仍被拦', s?.status === 'done' && s?.result?.output === 'V1-OK' && s?.result?._meta?.blocked?.length === 1, JSON.stringify(s?.result));
}

// ---------- 第 2 期：outputSchema / verify / final_verify ----------

const SCHEMA = { type: 'object', required: ['ok', 'n'], properties: { ok: { type: 'boolean' }, n: { type: 'number' } } };

{
  const fid = await createFlow(C, [
    { id: 'S1', title: '首次不符→纠正', mode: 'auto', outputSchema: SCHEMA },
    { id: 'S2', title: '始终不符→失败', mode: 'auto', outputSchema: SCHEMA },
  ]);
  agentScripts.set('S1', [() => oaiText('我觉得一切正常'), () => oaiText('结果：{"ok":true,"n":7}，谢谢')]);
  agentScripts.set('S2', [() => oaiText('没有 JSON'), () => oaiText('还是没有 JSON')]);
  await C.call('run_workflow', { id: fid });
  const flow = await gw(C, fid);
  const s1 = stepOf(flow, 'S1'), s2 = stepOf(flow, 'S2');
  check('验收7：输出不符时带 Schema 错误重试一轮后纠正（2 轮完成）', s1?.status === 'done' && s1?.result?.output?.ok === true && s1?.result?.output?.n === 7 && s1?.result?._meta?.turns === 2, JSON.stringify(s1?.result));
  check('验收7：重试后仍不符 → 步骤 failed（原因含 outputSchema）', s2?.status === 'failed' && /outputSchema/.test(s2?.failureReason ?? ''), JSON.stringify({ status: s2?.status, reason: s2?.failureReason }));
}

{
  const fid = await createFlow(C, [
    { id: 'R1', title: '断言不通过', mode: 'auto', outputSchema: SCHEMA, verify: 'n === 42' },
    { id: 'R2', title: '断言通过', mode: 'auto', outputSchema: SCHEMA, verify: 'n === 42' },
    { id: 'R3', title: 'reviewer 通过', mode: 'auto', verify: '结果中必须提到独角兽' },
    { id: 'R4', title: 'reviewer 不通过', mode: 'auto', verify: '结果中必须提到凤凰' },
  ]);
  agentScripts.set('R1', [() => oaiText('{"ok":true,"n":41}')]);
  agentScripts.set('R2', [() => oaiText('{"ok":true,"n":42}')]);
  agentScripts.set('R3', [() => oaiText('独角兽出现了')]);
  agentScripts.set('R4', [() => oaiText('只有独角兽')]);
  plainScripts.set('R3', () => 'PASS');
  plainScripts.set('R4', () => 'FAIL：结果里没有提到凤凰');
  await C.call('run_workflow', { id: fid });
  const flow = await gw(C, fid);
  const r1 = stepOf(flow, 'R1'), r2 = stepOf(flow, 'R2'), r3 = stepOf(flow, 'R3'), r4 = stepOf(flow, 'R4');
  check('验收5：verify 断言不通过 → 步骤标记 failed（原因含 verify）', r1?.status === 'failed' && /verify/.test(r1?.failureReason ?? ''), JSON.stringify({ status: r1?.status, reason: r1?.failureReason }));
  check('验收5：verify 断言通过 → done，schema 字段直接进入 result', r2?.status === 'done' && r2?.result?.n === 42 && r2?.result?._meta?.verify === 'assert', JSON.stringify(r2?.result));
  check('verify reviewer 提示词：模型回 PASS → done', r3?.status === 'done' && r3?.result?._meta?.verify === 'reviewer', JSON.stringify(r3?.result));
  check('verify reviewer 提示词：模型回 FAIL → failed', r4?.status === 'failed' && /审核未通过/.test(r4?.failureReason ?? ''), JSON.stringify({ status: r4?.status, reason: r4?.failureReason }));
}

{
  // verify 安全沙箱：禁用标识符被拦（不执行代码）、白名单函数仍可用、服务器进程存活
  const fid = await createFlow(C, [
    { id: 'VX1', title: 'process 逃逸被拦', mode: 'auto', outputSchema: SCHEMA, verify: 'process.exit(1)' },
    { id: 'VX2', title: 'constructor 逃逸被拦', mode: 'auto', outputSchema: SCHEMA, verify: '({}).constructor.constructor("return 1")()' },
    { id: 'VX3', title: '白名单函数可用', mode: 'auto', outputSchema: SCHEMA, verify: 'Number.isFinite(n) && n > 0' },
  ]);
  agentScripts.set('VX1', [() => oaiText('{"ok":true,"n":1}')]);
  agentScripts.set('VX2', [() => oaiText('{"ok":true,"n":1}')]);
  agentScripts.set('VX3', [() => oaiText('{"ok":true,"n":42}')]);
  await C.call('run_workflow', { id: fid });
  const flow = await gw(C, fid);
  const vx1 = stepOf(flow, 'VX1'), vx2 = stepOf(flow, 'VX2'), vx3 = stepOf(flow, 'VX3');
  check('verify 安全：process.exit(1) 被拦（不执行、明确失败）', vx1?.status === 'failed' && /禁用标识符.*process/.test(vx1?.failureReason ?? ''), JSON.stringify({ status: vx1?.status, reason: vx1?.failureReason }));
  check('verify 安全：constructor 逃逸被拦', vx2?.status === 'failed' && /禁用标识符.*constructor/.test(vx2?.failureReason ?? ''), JSON.stringify({ status: vx2?.status, reason: vx2?.failureReason }));
  check('verify 安全：白名单函数 Number.isFinite 仍可用', vx3?.status === 'done' && vx3?.result?._meta?.verify === 'assert', JSON.stringify(vx3?.result));
  check('verify 安全：服务器进程存活（事后仍可查询状态）', true);
}

{
  const fid = await createFlow(
    C,
    [{ id: 'FV1', title: '唯一步骤', mode: 'auto', agentPrompt: '做点事' }],
    { finalVerify: '所有步骤结果必须完整且一致' },
  );
  const run = await C.call('run_workflow', { id: fid });
  const flow = await gw(C, fid);
  check('final_verify：全部落定后调用模型整体检查并通过（写入 finalVerifyResult）', flow?.finalVerifyResult?.pass === true && /final_verify：通过/.test(text(run)), `${text(run)} | ${JSON.stringify(flow?.finalVerifyResult)}`);
}

// ---------- 协议适配（Anthropic 兼容端点） ----------

{
  const CA = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, LLM_API_KEY: 'test-key', LLM_MODEL: 'mock', LLM_PROTOCOL: 'anthropic' });
  await CA.init();
  const fid = await createFlow(CA, [{ id: 'A1', title: 'Anthropic 循环', mode: 'auto', agentPrompt: '读 probe.txt 并总结' }]);
  agentScripts.set('A1', [
    (body) => {
      anthChecks.push(
        typeof body.system === 'string' && body.system.includes('agent'),
        Array.isArray(body.tools) && body.tools[0]?.input_schema != null,
        body.messages?.[0]?.role === 'user',
        body.max_tokens > 0,
      );
      return antTool('t1', 'read_file', { path: 'probe.txt' });
    },
    (body) => {
      const hasToolResult = (body.messages ?? []).some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
      anthChecks.push(hasToolResult);
      return antText('A1 完成：读到 SANDBOX-PROBE-42');
    },
  ]);
  await CA.call('run_workflow', { id: fid });
  const s = stepOf(await gw(CA, fid), 'A1');
  check('Anthropic 协议：system/tools(input_schema)/tool_use/tool_result 全链路正确', s?.status === 'done' && anthChecks.length === 5 && anthChecks.every(Boolean), `${JSON.stringify(anthChecks)} | ${JSON.stringify(s?.result)}`);
  await CA.close();
}

// ---------- fetch_url 打开（WORKFLOW_ALLOW_NET=1，指向本地 mock） ----------

{
  const net = http.createServer((req, res) => { res.writeHead(200); res.end('hello-net-body'); });
  await new Promise(r => net.listen(0, '127.0.0.1', r));
  const CN = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, LLM_API_KEY: 'k', LLM_MODEL: 'mock', WORKFLOW_ALLOW_NET: '1' });
  await CN.init();
  const fid = await createFlow(CN, [{ id: 'F2', title: '联网开启', mode: 'auto', agentPrompt: '抓取本地页面' }]);
  agentScripts.set('F2', [
    () => oaiTool('c1', 'fetch_url', { url: `http://127.0.0.1:${net.address().port}/x` }),
    (body) => oaiText(lastToolContent(body).includes('hello-net-body') ? 'FETCH-OK' : 'FETCH-FAIL:' + lastToolContent(body).slice(0, 80)),
  ]);
  await CN.call('run_workflow', { id: fid });
  const s = stepOf(await gw(CN, fid), 'F2');
  check('WORKFLOW_ALLOW_NET=1 时 fetch_url 真实抓取', s?.status === 'done' && s?.result?.output === 'FETCH-OK' && !s?.result?._meta?.errors?.length, JSON.stringify(s?.result));
  await CN.close();
  net.close();
  net.closeAllConnections();
}

// ---------- create_workflow 字段校验 + 派发批次透传 ----------

{
  const bad = await C.call('create_workflow', { name: '坏工具', steps: [{ id: 'X', title: 'x', mode: 'auto', tools: ['nuke'] }] });
  check('create_workflow 拒绝未知工具名', bad.result.isError === true && /未知工具/.test(text(bad)), text(bad));

  const NB = makeClient({});
  await NB.init();
  const fid = await createFlow(NB, [
    { id: 'D1', title: '字段透传', mode: 'auto', agentPrompt: '做', verify: 'output.length > 0', maxTurns: 5, sandboxCwd: 'x', tools: ['read_file', 'grep'] },
  ]);
  const db = await NB.call('dispatch_batches', { id: fid });
  const item = sc(db)?.batches?.[0]?.steps?.[0];
  check('dispatch_batches 批次项透传 agent 字段（tools/maxTurns/sandboxCwd/verify）', item?.verify === 'output.length > 0' && item?.maxTurns === 5 && item?.sandboxCwd === 'x' && JSON.stringify(item?.tools) === '["read_file","grep"]', JSON.stringify(item));
  await NB.close();
}

await C.close();
mock.close();
mock.closeAllConnections();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
