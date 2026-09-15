// SPEC.md 验收测试（2-6）+ schema1 迁移。自带 mock LLM 服务器（node:http），零依赖。
// 运行：node test/run.test.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'server.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mcp-test-'));

// ---------- mock LLM：记录调用/并发峰值，FAILME 一律 500 ----------

const calls = []; // { id, t }
let peak = 0, inFlight = 0;
const DELAY = 150;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    // agent 循环后请求里带 system 消息，步骤 id 在 user 消息里 → 直接对原始报文全文匹配
    const prompt = body;
    const id = /（id: ([A-Za-z0-9_-]+)）/.exec(prompt)?.[1] ?? '?';
    calls.push({ id, t: Date.now(), prompt });
    inFlight++; peak = Math.max(peak, inFlight);
    setTimeout(() => {
      inFlight--;
      if (prompt.includes('FAILME')) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock failure' }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: `${id} 的模拟执行结果` } }],
        }));
      }
    }, DELAY);
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const MOCK_PORT = mock.address().port;

// ---------- MCP 客户端 ----------

function makeClient(env) {
  const proc = spawn(process.execPath, [SERVER, '--root', ROOT], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  let buf = '';
  const pending = new Map();
  let seq = 1;
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
  const send = obj => proc.stdin.write(JSON.stringify(obj) + '\n');
  const rpc = (method, params) => {
    const id = seq++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`超时：${method}`)); } }, 30000);
    });
  };
  return {
    proc, rpc, send,
    call: (name, args) => rpc('tools/call', { name, arguments: args }),
    init: async () => {
      const i = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return i;
    },
    close: () => new Promise(r => {
      if (proc.exitCode !== null || proc.signalCode) return r(); // 已被 kill 的进程不会再发 exit 事件
      proc.on('exit', r);
      proc.stdin.end();
    }),
  };
}

let failed = 0;
function check(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${cond ? '' : '  ' + String(extra).slice(0, 300)}`);
  if (!cond) failed++;
}
const text = r => r?.result?.content?.[0]?.text ?? '';
const sc = r => r?.result?.structuredContent;

// ---------- 0. schema1 旧数据迁移 ----------

fs.mkdirSync(path.join(ROOT, 'flows'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'flows', 'legacy-ab12.json'), JSON.stringify({
  schema: 1, id: 'legacy-ab12', name: '旧流', description: 'v1 数据',
  createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z',
  steps: [
    { id: 'A', title: '旧A', instruction: '', dependsOn: [], gate: null, done: true, skipped: false, skipReason: null, result: { legacy: 1 }, completedAt: '2026-09-14T00:00:00Z' },
    { id: 'B', title: '旧B', instruction: '', dependsOn: ['A'], gate: null, done: false, skipped: false, skipReason: null, result: null, completedAt: null },
  ],
}));

const A = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, LLM_API_KEY: 'test-key', LLM_MODEL: 'mock', LLM_MAX_CONCURRENCY: '4' });
await A.init();

{
  const st = await A.call('workflow_status', { id: 'legacy-ab12' });
  check('迁移：schema1 可读且状态正确（A=done，B=待办）', /✅ done A/.test(text(st)) && /B/.test(text(st)), text(st));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'flows', 'legacy-ab12.json'), 'utf8'));
  check('迁移：落盘文件已升级 schema=2', raw.schema === 2 && raw.steps[0].status === 'done');
}

// ---------- 2. 并行正确性：A → (B, C) → D[gate B && C] 全 auto ----------

{
  calls.length = 0; peak = 0;
  const c = await A.call('create_workflow', {
    name: '并行验证', description: '并行测试',
    steps: [
      { id: 'A', title: '步A', mode: 'auto', agentPrompt: '做A' },
      { id: 'B', title: '步B', dependsOn: ['A'], mode: 'auto' },
      { id: 'C', title: '步C', dependsOn: ['A'], mode: 'auto' },
      { id: 'D', title: '步D', dependsOn: ['B', 'C'], gate: 'B && C', mode: 'auto' },
    ],
  });
  const fid = sc(c)?.id;
  const run = await A.call('run_workflow', { id: fid });
  const ids = calls.map(x => x.id);
  check('验收2：run_workflow 全部完成', /完成 4\/4/.test(text(run)) && !/失败 [1-9]/.test(text(run)), text(run));
  check('验收2：A 最先执行', ids[0] === 'A', ids.join(','));
  check('验收2：B、C 构成第二批（顺序不定）', JSON.stringify(ids.slice(1, 3).sort()) === JSON.stringify(['B', 'C']), ids.join(','));
  check('验收2：D 在 B、C 之后才执行', ids[3] === 'D' && ids.indexOf('D') > ids.indexOf('B') && ids.indexOf('D') > ids.indexOf('C'), ids.join(','));
  check('验收2：B、C 确实并行（并发峰值 ≥ 2）', peak >= 2, `peak=${peak}`);
}

// ---------- 3. 门控在自动模式下生效：gate 为假不调模型 ----------

{
  calls.length = 0;
  const c = await A.call('create_workflow', {
    name: '门控验证',
    steps: [
      { id: 'S', title: '主路', mode: 'auto' },
      { id: 'T', title: '旁路', dependsOn: ['S'], gate: '!S', mode: 'auto' },
      { id: 'U', title: '后置', dependsOn: ['T'], mode: 'auto' },
    ],
  });
  const fid = sc(c)?.id;
  const run = await A.call('run_workflow', { id: fid });
  const called = new Set(calls.map(x => x.id));
  check('验收3：gate "!S" 为假 → T 被自动跳过且未调模型', !called.has('T'), calls.map(x => x.id).join(','));
  check('验收3：T 跳过后其下游 U 也无法就绪（卡住而非误跑）', /卡住|没有|完成 1\/3|被阻塞/.test(text(run)) || called.has('U') === false, text(run));
  const st = await A.call('workflow_status', { id: fid });
  check('验收3：状态中 T 显示 skipped', /⏭️.*T.*门条件/.test(text(st)), text(st));
}

// ---------- 4. 失败隔离：三路并行一路失败，其余照常 ----------

{
  calls.length = 0;
  const c = await A.call('create_workflow', {
    name: '失败隔离',
    steps: [
      { id: 'P1', title: '路1', mode: 'auto' },
      { id: 'P2', title: '路2', dependsOn: ['P1'], mode: 'auto' },
      { id: 'P3', title: '路3', dependsOn: ['P1'], mode: 'auto' },
      { id: 'PF', title: '坏路', dependsOn: ['P1'], mode: 'auto', agentPrompt: 'FAILME 这一步注定失败', maxRetries: 1 },
      { id: 'PZ', title: '汇合', dependsOn: ['P2', 'P3'], gate: 'P2 && P3', mode: 'auto' },
    ],
  });
  const fid = sc(c)?.id;
  const run = await A.call('run_workflow', { id: fid });
  const st = await A.call('workflow_status', { id: fid });
  const pfCalls = calls.filter(x => x.id === 'PF').length;
  check('验收4：PF 标记 failed（含原因与次数）', /❌.*failed.*PF|PF.*失败/.test(text(st)), text(st));
  check('验收4：PF 按 maxRetries=1 重试共调用 2 次', pfCalls === 2, `实际 ${pfCalls}`);
  check('验收4：P2/P3/PZ 照常完成', /完成 4\/5/.test(text(run)), text(run));
}

// ---------- 5. 断点续跑：已 done 不重跑 + 进程重启后状态仍在 ----------

{
  calls.length = 0;
  const c = await A.call('create_workflow', {
    name: '续跑验证',
    steps: [
      { id: 'R1', title: '已完成步', mode: 'auto' },
      { id: 'R2', title: '待跑步', dependsOn: ['R1'], mode: 'auto' },
    ],
  });
  const fid = sc(c)?.id;
  await A.call('complete_step', { id: fid, stepId: 'R1', result: { from: '上次运行' } }); // 模拟上次跑到一半
  const run = await A.call('run_workflow', { id: fid });
  check('验收5：已 done 的 R1 未被重跑（mock 未收到 R1）', !calls.some(x => x.id === 'R1') && /完成 2\/2/.test(text(run)), `${calls.map(x => x.id)} | ${text(run)}`);

  // 杀进程 → 新进程同一 ROOT 继续
  const stBefore = await A.call('workflow_status', { id: fid });
  A.proc.kill();
  await new Promise(r => A.proc.on('exit', r));
  const B = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, LLM_API_KEY: 'test-key', LLM_MODEL: 'mock' });
  await B.init();
  const stAfter = await B.call('workflow_status', { id: fid });
  check('验收5：进程重启后持久化状态完整', text(stAfter) === text(stBefore), `${text(stBefore)} ⇄ ${text(stAfter)}`);
  await B.close();
}

// ---------- 6. 方案A/B 切换 + cancel_run ----------

{
  const NB = makeClient({}); // 未配置密钥
  await NB.init();
  const c = await NB.call('create_workflow', {
    name: '派发验证', description: 'B 模式测试',
    steps: [
      { id: 'M1', title: '准备', mode: 'auto', agentPrompt: '准备素材' },
      { id: 'M2', title: '加工', dependsOn: ['M1'], mode: 'auto' },
      { id: 'M3', title: '人工确认', dependsOn: ['M2'], mode: 'manual' },
    ],
  });
  const fid = sc(c)?.id;
  await NB.call('complete_step', { id: fid, stepId: 'M1', result: { data: '上游产出' } });
  const run = await NB.call('run_workflow', { id: fid });
  check('验收6：无密钥时 run_workflow 退化为派发模式', /派发批次/.test(text(run)) && sc(run)?.dispatched === true, text(run));
  const db = await NB.call('dispatch_batches', { id: fid });
  const batch1 = sc(db)?.batches?.[0];
  const m2 = batch1?.steps?.find(s => s.stepId === 'M2');
  check('验收6：dispatch_batches 返回批次+提示词+上游结果', batch1?.stepIds?.includes('M2') && m2?.prompt?.includes('上游产出') && m2?.upstreamResults?.M1?.data === '上游产出', JSON.stringify(sc(db)).slice(0, 300));

  // cancel：慢 mock + 取消
  const slow = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'slow ok' } }] }));
    }, 1500));
  });
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  const C = makeClient({ LLM_BASE_URL: `http://127.0.0.1:${slow.address().port}`, LLM_API_KEY: 'k', LLM_MODEL: 'm' });
  await C.init();
  const cf = await C.call('create_workflow', { name: '取消验证', steps: [{ id: 'X1', title: '慢步', mode: 'auto' }, { id: 'X2', title: '慢步2', mode: 'auto' }] });
  const xid = sc(cf)?.id;
  const runPromise = C.rpc('tools/call', { name: 'run_workflow', arguments: { id: xid } });
  await new Promise(r => setTimeout(r, 200)); // 等它进入 running
  const cancel = await C.call('cancel_run', { id: xid });
  const runOut = await runPromise;
  check('cancel_run：请求取消成功且步骤回到待办', /已请求取消/.test(text(cancel)) && /打断/.test(text(runOut)), `${text(cancel)} | ${text(runOut)}`);
  const stx = await C.call('workflow_status', { id: xid });
  check('cancel_run：状态无 failed/running 残留', !/running|failed/.test(text(stx)), text(stx));
  await C.close();
  await NB.close();
  slow.close();
  slow.closeAllConnections(); // fetch 的 keep-alive 长连接不掐掉，close() 会一直等
}

await A.close();
mock.close();
mock.closeAllConnections();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
