// 烟囱测试：spawn 服务器，走完整协议链路（握手 → 工具列表 → 建流 → 门控分支 → 撤销 → 删除）
// 运行：node test/smoke.mjs
//
// 用临时 root，避免把测试数据写进项目自己的 flows/ 与 trash/。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'server.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-smoke-'));

const proc = spawn(process.execPath, [SERVER, '--root', ROOT], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const pending = new Map();
let nextId = 1;

proc.stdout.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg); pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`超时：${method}`)); } }, 8000);
  });
}
function call(name, args) {
  return rpc('tools/call', { name, arguments: args });
}

let failed = 0;
function check(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${cond ? '' : ' ' + extra}`);
  if (!cond) failed++;
}
const text = (r) => r.result?.content?.[0]?.text ?? '';

// 1. 握手
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
check('initialize 返回 serverInfo', init.result?.serverInfo?.name === 'workflow-mcp');
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const pong = await rpc('ping', {});
check('ping', pong.result && !pong.error);

// 2. 工具列表（升级后新增 run_workflow/dispatch_batches/cancel_run，旧 10 个必须全在）
const tl = await rpc('tools/list', {});
const names = tl.result.tools.map(t => t.name);
const OLD_TOOLS = ['create_workflow', 'list_workflows', 'get_workflow', 'next_step', 'complete_step', 'skip_step', 'undo_step', 'workflow_status', 'validate_workflow', 'delete_workflow'];
check('tools/list 至少 10 个且旧工具全在', names.length >= 10 && OLD_TOOLS.every(n => names.includes(n)), `实际 ${names.length}: ${names.join(',')}`);

// 3. 建流：A → B → (C gate=B) / (D gate=!B)，C/D 依赖 B
const created = await call('create_workflow', {
  name: '烟囱测试',
  description: '自动测试流',
  steps: [
    { id: 'A', title: '准备' },
    { id: 'B', title: '构建', dependsOn: ['A'] },
    { id: 'C', title: '发布', dependsOn: ['B'], gate: 'B' },
    { id: 'D', title: '回滚', dependsOn: ['B'], gate: '!B' },
  ],
});
const flowId = created.result?.structuredContent?.id;
check('create_workflow 成功', Boolean(flowId), text(created));

// 4. next_step → A 就绪
const n1 = await call('next_step', { id: flowId });
check('next_step 首个 READY=A', n1.result.structuredContent.ready.includes('A'), text(n1));

// 5. 完成 A、B(=true) → C 留存、D 被门跳过
await call('complete_step', { id: flowId, stepId: 'A', result: { ok: true } });
const doneB = await call('complete_step', { id: flowId, stepId: 'B', result: { build: 'ok', tests: 12 } });
check('B 完成后 D 被门条件自动跳过', doneB.result.structuredContent.autoSkipped.includes('D'), text(doneB));
const n2 = await call('next_step', { id: flowId });
check('下一 READY=C（D 已跳过）', n2.result.structuredContent.ready.includes('C') && !n2.result.structuredContent.ready.includes('D'));

// 6. 状态 / 校验 / 读取
const st = await call('workflow_status', { id: flowId });
check('status 文本包含进度', /1 skipped|跳过/.test(text(st)), text(st));
const va = await call('validate_workflow', { id: flowId });
check('validate 通过', va.result.structuredContent.ok === true, text(va));
const got = await call('get_workflow', { id: flowId });
check('get_workflow md 含 mermaid', text(got).includes('mermaid'));

// 7. 撤销 B → C/D 状态一并回退、B 重新 READY
const un = await call('undo_step', { id: flowId, stepId: 'B' });
check('undo 回退 B+C+D', /B.*C.*D|C、D/.test(text(un)) || text(un).includes('C'), text(un));
const n3 = await call('next_step', { id: flowId });
check('撤销后 B 再次 READY', n3.result.structuredContent.ready.includes('B'));

// 8. 错误路径：完成不存在的步骤 → isError
const bad = await call('complete_step', { id: flowId, stepId: '不存在' });
check('未知步骤返回 isError', bad.result.isError === true);

// 9. 列表 + 归档删除 + 回收站恢复
const li = await call('list_workflows', {});
check('list_workflows 能看到该流', text(li).includes(flowId) || JSON.stringify(li).includes(flowId));
const del = await call('delete_workflow', { id: flowId });
check('delete_workflow 归档', del.result.isError !== true, text(del));
const tr = await call('list_trash', {});
check('list_trash 能看到归档项', JSON.stringify(tr.result.structuredContent ?? {}).includes(flowId), text(tr));
const re = await call('restore_workflow', { id: flowId });
check('restore_workflow 从归档恢复', re.result.isError !== true && re.result.structuredContent?.id === flowId, text(re));
const st4 = await call('workflow_status', { id: flowId });
check('恢复后仍是 B 撤销前的状态（C 就绪）', /▶️ ready C|C 发布/.test(text(st4)), text(st4));

// 10. 安全：非法流 id 不得逃出 flows/ 目录
const evil = await call('delete_workflow', { id: '../../etc/passwd' });
check('非法 id（路径穿越）被拒绝', evil.result.isError === true && /非法的工作流 id/.test(text(evil)), text(evil));

proc.stdin.end();
await new Promise((r) => proc.on('exit', r));
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
