// 加固回归测试：覆盖本次优化新引入/修复的行为，防止以后改坏。
//   1) 纯函数单测：扩展版 outputSchema 校验、JSON 容错提取、按流串行锁、id 安全化
//   2) 集成测试：崩溃残留 running 的回收与续跑、损坏文件不拖垮列表、非法 id 拒绝、
//                服务器级步骤默认值（WORKFLOW_MAX_TURNS）生效、outputSchema 全链路
// 运行：node test/harden.test.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSchema, extractJson, safeJsonArgs } from '../lib/agent.mjs';
import { withLock } from '../lib/lock.mjs';
import { assertSafeFlowId, sanitizeName } from '../lib/schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'server.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-harden-'));

let failed = 0;
function check(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${cond ? '' : '  ' + String(extra).slice(0, 300)}`);
  if (!cond) failed++;
}

// ---------- 1. 纯函数单测 ----------

{
  const SCHEMA = {
    type: 'object', required: ['n', 'tags'], additionalProperties: false,
    properties: {
      n: { type: 'number', minimum: 10, maximum: 100 },
      tags: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^#\\d+$' } },
      label: { type: 'string', minLength: 2 },
    },
  };
  check('schema：合法值通过', validateSchema(SCHEMA, { n: 42, tags: ['#1'] }).length === 0);
  const bad = validateSchema(SCHEMA, { n: 5, tags: [], label: 'a', extra: 1 });
  check('schema：minimum/maximum 生效', bad.some(p => /应 ≥ 10/.test(p)), JSON.stringify(bad));
  check('schema：minItems 生效', bad.some(p => /元素数应 ≥ 1/.test(p)), JSON.stringify(bad));
  check('schema：minLength 生效', bad.some(p => /长度应 ≥ 2/.test(p)), JSON.stringify(bad));
  check('schema：additionalProperties:false 生效', bad.some(p => /未声明字段 "extra"/.test(p)), JSON.stringify(bad));
  check('schema：items.pattern 生效', validateSchema(SCHEMA, { n: 20, tags: ['nope'] }).some(p => /不匹配 pattern/.test(p)));
  check('schema：const/enum 生效', validateSchema({ const: 'x' }, 'y').length === 1 && validateSchema({ enum: [1, 2] }, 3).length === 1);

  check('extractJson：整段 JSON', extractJson('{"a":1}').a === 1);
  check('extractJson：夹带说明文字仍可提取', extractJson('结果如下：{"a":2}，谢谢').a === 2);
  check('extractJson：字符串内的花括号不误判', extractJson('{"a":"}{"}').a === '}{');
  check('extractJson：无 JSON 返回 null', extractJson('完全没有') === null);
  check('safeJsonArgs：截断的 JSON 不抛错', typeof safeJsonArgs('{"a":1') === 'object');
  check('safeJsonArgs：完全非 JSON 的字符串降级为空参数对象', JSON.stringify(safeJsonArgs('hello')) === '{}');
}

{
  // 按流串行：同 key 严格排队，不同 key 互不阻塞
  const order = [];
  const mk = (tag, ms) => withLock('flow-1', async () => {
    order.push(`${tag}:start`);
    await new Promise(r => setTimeout(r, ms));
    order.push(`${tag}:end`);
  });
  const other = withLock('flow-2', async () => { order.push('other'); });
  await Promise.all([mk('a', 30), mk('b', 5), other]);
  check('withLock：同一 key 串行（a 的 end 早于 b 的 start）',
    order.indexOf('a:end') < order.indexOf('b:start'), order.join(','));
  check('withLock：不同 key 不互相阻塞（other 在 a 结束前就跑完）',
    order.indexOf('other') < order.indexOf('a:end'), order.join(','));

  const failedFn = await withLock('flow-3', async () => { throw new Error('boom'); }).catch(e => e.message);
  const after = await withLock('flow-3', async () => 'ok');
  check('withLock：一次失败不会卡死后续队列', failedFn === 'boom' && after === 'ok');
}

{
  check('assertSafeFlowId：拒绝路径穿越', (() => { try { assertSafeFlowId('../../etc/passwd'); return false; } catch { return true; } })());
  check('assertSafeFlowId：拒绝子目录', (() => { try { assertSafeFlowId('a/b'); return false; } catch { return true; } })());
  check('assertSafeFlowId：接受正常 id', assertSafeFlowId('烟囱测试-ab12') === '烟囱测试-ab12');
  check('sanitizeName：剥掉分隔符与连续点', !sanitizeName('a/../b c').includes('..') && !/[/\\]/.test(sanitizeName('a/b\\c')));
}

// ---------- 2. 集成测试 ----------

const oaiTool = (id, name, args) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const oaiText = (t) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: t } }] });

// 慢 mock：用于制造"跑到一半被杀"的场景
const slowMock = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(oaiText('slow-ok')));
  }, 3000));
});
await new Promise(r => slowMock.listen(0, '127.0.0.1', r));

// 脚本化 mock：按步骤 id 返回预设序列
const scripts = new Map();
const seqMap = new Map();
const fastMock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => raw += c);
  req.on('end', () => {
    let body = {}; try { body = JSON.parse(raw); } catch { /* ignore */ }
    const stepId = (raw.match(/（id: ([A-Za-z0-9_-]+)）/) || [])[1] ?? '?';
    res.writeHead(200, { 'content-type': 'application/json' });
    const isAgentTurn = Array.isArray(body.tools) && body.tools.length > 0;
    if (!isAgentTurn) { res.end(JSON.stringify(oaiText('PASS'))); return; }
    const i = seqMap.get(stepId) ?? 0;
    seqMap.set(stepId, i + 1);
    const script = scripts.get(stepId);
    res.end(JSON.stringify(script ? script[Math.min(i, script.length - 1)](body, raw) : oaiText(`${stepId}-ok`)));
  });
});
await new Promise(r => fastMock.listen(0, '127.0.0.1', r));

function makeClient(env) {
  const proc = spawn(process.execPath, [SERVER, '--root', ROOT], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  let buf = '';
  const pending = new Map();
  let sid = 1;
  proc.stdout.on('data', d => {
    buf += d; let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const rpc = (method, params) => {
    const id = sid++;
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
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'h', version: '0' } });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    kill: async () => new Promise(r => {
      if (proc.exitCode !== null || proc.signalCode) return r();
      proc.on('exit', r);
      proc.kill();
    }),
    close: () => new Promise(r => {
      if (proc.exitCode !== null || proc.signalCode) return r();
      proc.on('exit', r);
      proc.stdin.end();
    }),
  };
}
const text = r => r?.result?.content?.[0]?.text ?? '';
const sc = r => r?.result?.structuredContent;
const mkFlow = async (c, steps, extra = {}) =>
  sc(await c.call('create_workflow', { name: `harden-${Math.random().toString(36).slice(2, 7)}`, steps, ...extra }))?.id;
const stepOf = async (c, fid, id) => (sc(await c.call('get_workflow', { id: fid, format: 'json' }))?.steps ?? []).find(s => s.id === id);

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

// --- 2.1 服务器级默认值生效：WORKFLOW_MAX_TURNS=2 应压住未显式配置的 maxTurns ---
{
  const C = makeClient({
    LLM_BASE_URL: `http://127.0.0.1:${fastMock.address().port}`, LLM_API_KEY: 'k', LLM_MODEL: 'mock',
    WORKFLOW_MAX_TURNS: '2',
  });
  await C.init();

  scripts.set('Z1', [() => oaiTool('a', 'list_dir', {}), () => oaiTool('b', 'list_dir', {}), () => oaiTool('c', 'list_dir', {})]);
  const fid = await mkFlow(C, [{ id: 'Z1', title: '轮数受服务器默认值限制', mode: 'auto' }]);
  await C.call('run_workflow', { id: fid });
  const s = await stepOf(C, fid, 'Z1');
  check('WORKFLOW_MAX_TURNS=2 作为默认值生效（步骤未配 maxTurns 也按 2 轮截断）',
    s?.status === 'failed' && /maxTurns=2/.test(s?.failureReason ?? ''), JSON.stringify({ status: s?.status, reason: s?.failureReason }));

  // create_workflow 的字段范围校验
  const badTurns = await C.call('create_workflow', { name: 'x', steps: [{ id: 'x', title: 'x', mode: 'auto', maxTurns: 999 }] });
  check('create_workflow 拒绝越界 maxTurns', badTurns.result.isError === true && /maxTurns/.test(text(badTurns)), text(badTurns));
  const badId = await C.call('create_workflow', { name: 'x', steps: [{ id: 'a b', title: 'x' }] });
  check('create_workflow 拒绝含空格的步骤 id（门条件无法引用）', badId.result.isError === true && /非法字符/.test(text(badId)), text(badId));
  const dupDep = await C.call('create_workflow', { name: 'x', steps: [{ id: 'A', title: 'a' }, { id: 'B', title: 'b', dependsOn: ['A'] }] });
  check('create_workflow 正常路径仍可用', dupDep.result.isError !== true, text(dupDep));

  await C.close();
}

// --- 2.2 outputSchema 全链路（扩展关键字） ---
const KSCHEMA = {
  type: 'object', required: ['n', 'tags'], additionalProperties: false,
  properties: { n: { type: 'number', minimum: 10 }, tags: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^#\\d+$' } } },
};
{
  const C = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${fastMock.address().port}`, LLM_API_KEY: 'k', LLM_MODEL: 'mock' });
  await C.init();
  scripts.set('K1', [() => oaiText('{"n":5,"tags":[]}'), () => oaiText('{"n":42,"tags":["#1","#2"]}')]);
  scripts.set('K2', [() => oaiText('{"ok":true,"extra":1}'), () => oaiText('{"ok":true,"extra":1}')]);
  const fid = await mkFlow(C, [
    { id: 'K1', title: '纠正后通过', mode: 'auto', outputSchema: KSCHEMA },
    { id: 'K2', title: '多余字段始终不符', mode: 'auto', outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false } },
  ]);
  await C.call('run_workflow', { id: fid });
  const k1 = await stepOf(C, fid, 'K1');
  const k2 = await stepOf(C, fid, 'K2');
  check('outputSchema 扩展关键字：首次不符（minimum/minItems）→ 纠正后通过且字段平铺进 result',
    k1?.status === 'done' && k1?.result?.n === 42 && k1?.result?._meta?.turns === 2, JSON.stringify(k1?.result));
  check('outputSchema：additionalProperties:false 不通过 → 重试仍不符 → failed 且原因可读',
    k2?.status === 'failed' && /未声明字段/.test(k2?.failureReason ?? ''), JSON.stringify({ status: k2?.status, reason: k2?.failureReason }));
  await C.close();
}

// --- 2.3 崩溃残留 running 的回收与续跑 ---
{
  const S = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${slowMock.address().port}`, LLM_API_KEY: 'k', LLM_MODEL: 'mock' });
  await S.init();
  const fid = await mkFlow(S, [
    { id: 'C1', title: '会被打断的慢步', mode: 'auto' },
    { id: 'C2', title: '后继步', dependsOn: ['C1'], mode: 'auto' },
  ]);
  const runPromise = S.rpc('tools/call', { name: 'run_workflow', arguments: { id: fid } }).catch(() => null);
  const running = await waitFor(async () => (await stepOf(S, fid, 'C1'))?.status === 'running');
  check('崩溃前：步骤确实处于 running（状态已落盘）', running);
  await S.kill();
  await runPromise;
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows', `${fid}.json`), 'utf8'));
  check('崩溃后：数据文件里残留 running（真实模拟进程被强杀）', onDisk.steps.find(s => s.id === 'C1')?.status === 'running',
    JSON.stringify(onDisk.steps.map(s => [s.id, s.status])));

  const R = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${fastMock.address().port}`, LLM_API_KEY: 'k', LLM_MODEL: 'mock' });
  await R.init();
  const st = await R.call('workflow_status', { id: fid });
  check('重启后：残留 running 被回收为待办（状态显示不撒谎）', !/running/.test(text(st)), text(st));
  const backOnDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows', `${fid}.json`), 'utf8'));
  check('重启后：回收结果已回写磁盘', backOnDisk.steps.find(s => s.id === 'C1')?.status === 'pending',
    JSON.stringify(backOnDisk.steps.map(s => [s.id, s.status])));
  const run2 = await R.call('run_workflow', { id: fid });
  check('续跑：被打断的步骤被重新执行并整条流完成', /完成 2\/2/.test(text(run2)), text(run2));
  await R.close();
}

// --- 2.4 损坏数据文件不拖垮列表；非法 id 不越界 ---
{
  fs.mkdirSync(path.join(ROOT, 'flows'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'flows', 'broken-zzzz.json'), '{ 这不是合法 JSON', 'utf8');

  const C = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${fastMock.address().port}`, LLM_API_KEY: 'k', LLM_MODEL: 'mock' });
  await C.init();
  const li = await C.call('list_workflows', {});
  check('list_workflows：单个损坏文件只标注该条，不影响整体', li.result.isError !== true && /无法读取/.test(text(li)), text(li));

  const gw = await C.call('get_workflow', { id: 'broken-zzzz' });
  check('get_workflow：损坏文件给出可读错误而不是原始异常', gw.result.isError === true && /损坏|结构异常/.test(text(gw)), text(gw));

  for (const bad of ['../../etc/passwd', 'a/../../b', 'x\u0000y']) {
    const r = await C.call('get_workflow', { id: bad });
    check(`非法 id 被拒绝：${JSON.stringify(bad)}`, r.result.isError === true && /非法的工作流 id|缺少工作流 id/.test(text(r)), text(r));
  }
  await C.close();
}

// --- 2.5 回收站闭环 + 手动步骤不被代跑 ---
{
  const C = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${fastMock.address().port}`, LLM_API_KEY: 'k', LLM_MODEL: 'mock' });
  await C.init();
  const fid = await mkFlow(C, [
    { id: 'T1', title: '自动步', mode: 'auto' },
    { id: 'T2', title: '人工步', dependsOn: ['T1'], mode: 'manual' },
  ]);
  const run = await C.call('run_workflow', { id: fid });
  check('run_workflow：manual 步骤不会被代跑，且摘要明确提示', /待人工处理.*T2/.test(text(run)), text(run));

  await C.call('delete_workflow', { id: fid });
  const tr = await C.call('list_trash', {});
  check('list_trash：能看到归档项', JSON.stringify(sc(tr) ?? {}).includes(fid), text(tr));
  const re = await C.call('restore_workflow', { id: fid });
  check('restore_workflow：恢复成功且进度保留', re.result.isError !== true && sc(re)?.id === fid, text(re));
  const re2 = await C.call('restore_workflow', { id: fid });
  check('restore_workflow：重复恢复给出明确提示', re2.result.isError === true && /找不到/.test(text(re2)), text(re2));
  await C.close();
}

slowMock.close();
slowMock.closeAllConnections();
fastMock.close();
fastMock.closeAllConnections();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
