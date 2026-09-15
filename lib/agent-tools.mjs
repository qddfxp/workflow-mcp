// 内置工具集 + 安全沙箱：agent 循环的"手和脚"。
//
// 仅供 agent 循环内部调用，不对外暴露成 MCP 工具。
// 本模块刻意不读任何环境变量——联网/危险命令开关由调用方通过 ctx 注入，
// 这样 config.mjs 可以安全地反向引用 KNOWN_TOOLS 而不产生循环依赖。
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';

export const KNOWN_TOOLS = ['read_file', 'write_file', 'list_dir', 'grep', 'bash', 'fetch_url'];

export const READ_MAX_BYTES = 2 * 1024 * 1024;   // read_file 单文件上限
export const WRITE_MAX_CHARS = 512 * 1024;       // write_file 单次写入上限
export const BASH_TIMEOUT_MS = 30000;            // bash 单命令硬超时
export const FETCH_TIMEOUT_MS = 15000;           // fetch_url 硬超时

// ---------- 小工具 ----------

export function cap(s, n = 4000) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + `…(已截断，共 ${t.length} 字符)` : t;
}
export function firstLine(s) { return cap(String(s ?? '').split('\n')[0], 200); }
export function shortArgs(a) {
  try {
    const s = JSON.stringify(a ?? {});
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  } catch { return '?'; }
}
export function needStr(v, name) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`参数 ${name} 必须是非空字符串`);
  return v;
}

// ---------- 安全沙箱 ----------

function assertInside(base, target, original) {
  const rel = path.relative(base, target);
  if (rel === '') return;
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    const e = new Error(`路径越界："${original}" 解析到沙箱 ${base} 之外，已拒绝`);
    e.blocked = true;
    throw e;
  }
}

// 规范化后强制限定在 sandbox 内；对已存在的路径再做一次 realpath 校验，
// 防止通过符号链接把访问点指向沙箱外（新建文件时 realpath 会 ENOENT，忽略即可）。
export function resolveInSandbox(sandbox, p) {
  const base = path.resolve(sandbox);
  const abs = path.resolve(base, p);
  assertInside(base, abs, p);
  try {
    assertInside(fs.realpathSync(base), fs.realpathSync(abs), p);
  } catch (e) {
    if (e.blocked) throw e;
    // 目标或沙箱本身尚不存在：字面量校验已经足够
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

// ---------- 工具定义 ----------

export const TOOL_DEFS = [
  {
    name: 'read_file',
    description: '读取沙箱内一个文本文件（UTF-8）。文件过大或越界会被拒绝。',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: '沙箱内相对路径' } } },
    run(args, ctx) {
      const p = resolveInSandbox(ctx.sandbox, needStr(args.path, 'path'));
      const st = fs.statSync(p);
      if (st.isDirectory()) throw new Error(`"${args.path}" 是目录，请用 list_dir`);
      if (st.size > READ_MAX_BYTES) throw new Error(`文件过大（${st.size} 字节），拒绝读取`);
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
      if (content.length > WRITE_MAX_CHARS) throw new Error(`content 超过 ${Math.round(WRITE_MAX_CHARS / 1024)}KB，拒绝写入`);
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
      if (!ctx.allowDangerous) {
        for (const [re, why] of DANGEROUS) {
          if (re.test(command)) {
            const e = new Error(`已拦截危险命令（${why}）：${cap(command, 120)}。如确需执行，请设置环境变量 WORKFLOW_ALLOW_DANGEROUS=1`);
            e.blocked = true;
            throw e;
          }
        }
      }
      const remaining = Math.max(1000, ctx.deadline - Date.now());
      const timeout = Math.min(BASH_TIMEOUT_MS, remaining);
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)].filter(Boolean));
      const { err, stdout, stderr } = await new Promise(resolve => {
        exec(command, { cwd: ctx.sandbox, timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal },
          (e, so, se) => resolve({ err: e, stdout: so, stderr: se }));
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
      if (!ctx.allowNet) {
        const e = new Error('联网已关闭：fetch_url 需要环境变量 WORKFLOW_ALLOW_NET=1');
        e.denied = true;
        throw e;
      }
      const url = needStr(args.url, 'url');
      if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http(s) URL');
      const method = String(args.method ?? 'GET').toUpperCase();
      const res = await fetch(url, {
        method, redirect: 'follow',
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)].filter(Boolean)),
      });
      return `HTTP ${res.status}\n${cap(await res.text(), 4000)}`;
    },
  },
];

const TOOL_MAP = Object.fromEntries(TOOL_DEFS.map(t => [t.name, t]));

// 统一执行入口：白名单外/未知工具一律拒绝，异常转成给模型看的错误文本，不抛出。
// 返回 { ok, content, blocked?, denied? }
export async function runTool(tc, ctx) {
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
