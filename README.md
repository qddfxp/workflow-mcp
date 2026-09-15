# workflow-mcp

确定性工作流 MCP 服务器：DAG 步骤图 + 布尔门分支 + **自动并行执行** + **步骤内 Agent 循环** + 断点续跑。纯 Node 标准库、零依赖、stdio 传输。

分支思想参考 [AgentFlow](https://github.com/kanghelyu/agent-flow)（MIT）的确定性门控设计：每个可选步骤带一个 `gate` 布尔表达式（`&&`、`||`、`!`、括号），只允许引用该步骤的直接依赖；依赖全部落定后求值**一次**，为假则该步骤被自动跳过。整个执行历史是确定性重放，中断后随时续跑。

## 快速上手

```
手动：create_workflow → 循环 { next_step → 做事 → complete_step } → validate_workflow
自动：create_workflow(steps 标 mode="auto") → run_workflow（或 dispatch_batches + 宿主并行执行 + complete_step）
```

## 工具（15 个）

| 工具 | 作用 |
|---|---|
| `create_workflow` | 新建工作流（结构/id 字符集/环/门条件校验在创建时完成） |
| `list_workflows` | 列出全部工作流与进度（单条数据损坏只标注该条，不影响整体） |
| `get_workflow` | 读取全文（json 结构化含 `ready` 列表 / md 人类可读含 mermaid 图，可见每步 manual/auto 与六态状态） |
| `next_step` | 返回当前 READY 步骤（手动循环入口） |
| `complete_step` | 提交步骤结果；自动求值下游门条件并回报新 READY |
| `skip_step` / `undo_step` | 人工跳过 / 撤销（undo 连带全部下游一起回退） |
| `workflow_status` / `validate_workflow` | 进度总览 / 确定性结构校验 |
| `delete_workflow` | 归档删除（移入 trash） |
| `list_trash` / `restore_workflow` | 查看归档 / 从归档恢复（delete 的闭环，不必手工改文件） |
| `run_workflow` | **自动执行**：READY 的 auto 步骤批内并行、批间串行，每步由服务器内 agent 循环驱动，自动推进门条件直到完成/卡住；可断点续跑 |
| `dispatch_batches` | **方案B入口**：返回可并行批次（步骤分组 + 拼装提示词 + 上游结果 + 服务器级默认值），宿主派子代理执行后 complete_step 回填 |
| `cancel_run` | 打断当前自动执行；运行中步骤回到待办 |

> 写类工具（`complete_step` / `skip_step` / `undo_step` / `delete_workflow` / `restore_workflow` / `run_workflow`）按**流 id 串行**执行。stdio 不会等上一条处理完就派发下一条消息，不串行会让两个调用各持一份快照互相覆盖。`cancel_run` 与只读工具刻意不加锁，所以执行中依然能查询状态、能打断。

## auto 步骤 = 服务器内的小 Agent

配置 `LLM_BASE_URL` + `LLM_API_KEY` 后，每个 auto 步骤不再是一次 prompt→一段文本，而是**步骤内 Agent 循环**（见 `docs/UPGRADE-agentic.md`）：

1. 首轮请求带内置工具定义 + 系统提示（沙箱目录、可用工具）+ 步骤提示词（含上游结果）；
2. 模型返回 `tool_calls` → 服务器在进程内执行工具 → 结果作为工具消息回喂 → 继续循环；
3. 直到模型给出最终文本，或达到 `maxTurns`（默认 8）/ 超时；
4. 最终文本（或符合 `outputSchema` 的 JSON）作为该步 `result.output`，工具写出的文件保留在磁盘。

### 内置工具（仅 agent 循环内部可用，不是 MCP 工具）

| 工具 | 说明 |
|---|---|
| `read_file {path}` | 读沙箱内文本文件（>2MB 拒绝，输出超长截断） |
| `write_file {path, content}` | 写文件（自动建父目录，>512KB 拒绝） |
| `list_dir {path?}` | 列目录（目录在前，最多 500 条） |
| `grep {pattern, path?}` | 正则搜索文件内容（跳过 node_modules/.git 与二进制，最多 100 条） |
| `bash {command}` | 沙箱 cwd 内执行命令（30s 超时、输出截断、危险命令拦截；Windows 走 cmd.exe） |
| `fetch_url {url, method?}` | HTTP(S) 抓取（**默认关闭**，`WORKFLOW_ALLOW_NET=1` 开启） |

### 安全沙箱

- 所有工具路径规范化后强制限定在 `sandboxCwd`（默认服务器根目录），`../` 逃逸一律拒绝并记入 `_meta.blocked`；
- 对**已存在**的路径还会再比对一次 `realpath`，防止用符号链接把访问点绕到沙箱外；
- `bash` 默认拦截危险命令（`rm -rf` / `del /s` / `format` / 注册表 / `shutdown` / 重定向到绝对路径等），`WORKFLOW_ALLOW_DANGEROUS=1` 才放行；
- 天花板：`bash` 内部命令本身仍可能触达沙箱外（如 `type C:\x`），拦截表是尽力而为，不是完整沙箱；MCP 进程也无法继承宿主的权限/上下文体系。

### 步骤字段（schema 2）

`{id?, title, instruction?, dependsOn?, gate?, mode?, agentPrompt?, model?, timeoutMs?, maxRetries?, tools?, maxTurns?, outputSchema?, verify?, sandboxCwd?}`

- `id`: 中英文/数字/下划线/连字符（缺省 `step-01/02…`）。**门条件按标识符解析，所以 id 不能含空格、点号等字符**，创建时会拒绝。
- `mode`: `"manual"`（缺省，等 complete_step）/ `"auto"`（run_workflow 自动执行）
- `tools`: 该步工具白名单（创建时校验名字合法，如 `["read_file","grep"]`）
- `maxTurns`: agent 循环最大轮数（缺省取 `WORKFLOW_MAX_TURNS`，8；范围 1-64）
- `timeoutMs`: 整步 agent 循环超时（缺省取 `WORKFLOW_STEP_TIMEOUT_MS`，120000）
- `maxRetries`: 失败/质量关未过后的重试次数（缺省取 `WORKFLOW_MAX_RETRIES`，0）
- `outputSchema`: 结果 JSON Schema；最终输出不符会带着错误重试一轮，仍不符则该步 `failed`。校验覆盖：`type` / `enum` / `const` / `required` / `properties` / `items` / `minItems` / `maxItems` / `minimum` / `maximum` / `minLength` / `maxLength` / `pattern` / `additionalProperties: false`
- `verify`: 完成后的质量关——合法 JS 布尔断言（如 `n === 42`、`output.includes('报告')`，作用在 result 字段上，配了 outputSchema 时字段直接可用）或 reviewer 提示词（调模型回 PASS/FAIL）；不通过 → 该步 failed（计入 `maxRetries` 重跑整步）
- `sandboxCwd`: 该步允许访问的目录（相对服务器根），缺省取 `WORKFLOW_SANDBOX`，否则服务器根目录
- 流程级 `finalVerify`（`create_workflow` 顶层可选）：全部步骤落定后把汇总结果交给模型做整体一致性检查，结论存入 `flow.finalVerifyResult`（只记录，不改变步骤状态）
- auto 步骤完成后的 `result` 形如 `{ ...(outputSchema 解析出的字段), output, _meta: { attempts, turns, toolCalls, blocked?, errors?, verify? } }`；`blocked` 记录被拦截的越界/危险操作。这些 `_meta` 只在存档里，**不会再灌进下游步骤的提示词**（`buildPrompt` 会剥掉）
- 步骤状态六态：`pending / ready / running / done / skipped / failed`；`failed` 视为已落定、门条件中恒为 `false`、**不算 skipped**
- 失败语义：重试耗尽只标记该步 `failed`，其余分支照常；无门的下游步骤因依赖 skipped/failed 会**级联跳过**（分支停止）——需要"失败走兜底"的分支请显式写门（如 `gate: "!T"`）
- 旧 `schema: 1` 数据（done/skipped 布尔）在首次读取时自动迁移到 v2 并回写

### 协议适配

- 默认 OpenAI 兼容（`{base}/chat/completions` + `tools`/`tool_calls`）；
- `LLM_PROTOCOL=anthropic` 或 URL 含 `anthropic` 时走 Anthropic 兼容（`{base}/v1/messages` + `tool_use`/`tool_result`）；
- `tool_calls` 解析容错：`arguments` 非 JSON 时尝试提取平衡的 `{...}`，字段缺失自动补 id，格式漂移不崩；
- HTTP 非 2xx 时把端点返回的错误正文一并带进失败原因，便于定位密钥/模型名/额度问题。

## 两种执行模式（共用同一套 DAG/门/状态机）

- **方案A 自含执行器**：配置 `LLM_BASE_URL` + `LLM_API_KEY` 后，服务器用进程内 agent 循环执行每步（内置 `fetch`，零第三方依赖）。步骤可覆盖 `model` / `timeoutMs` / `maxRetries`；并发上限 `LLM_MAX_CONCURRENCY`（默认 4，硬上限 32）。同一条流同时只允许一个执行。
- **方案B 宿主驱动**（缺省）：不配密钥时 `run_workflow` 自动退化为派发模式；也可显式 `dispatch_batches`。宿主 agent 拿批次并行派子代理，跑完逐个 `complete_step`。
- `mode` 参数可强制指定：`auto`=方案A（需密钥），`dispatch`=方案B。
- `run_workflow` 不会代跑 `manual` 步骤，摘要里会列出待人工处理的步骤。

## 断点续跑

- 已 `done` 的步骤绝不重跑，只补跑未完成的；
- 进程被强杀留下的 `running` 残留，在**下次读取时**（且确认没有正在执行的 run）自动退回 `pending` 并回写磁盘 —— 状态显示不会撒谎，续跑会重新派发该步；
- 状态落盘是**先写临时文件再 rename** 的原子写，避免并发读到半截 JSON。

## 环境变量

| 变量 | 说明 |
|---|---|
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | 方案A 的 LLM 端点、密钥、默认模型 |
| `LLM_MAX_CONCURRENCY` | 批内并行上限（默认 4，硬上限 32） |
| `LLM_PROTOCOL` | `openai`（默认）/ `anthropic`，缺省按 URL 自动识别 |
| `LLM_MAX_TOKENS` | 单次补全的输出上限（默认 4096，两种协议都生效） |
| `LLM_TEMPERATURE` | 采样温度（缺省不发送，交给端点默认值） |
| `WORKFLOW_MAX_TURNS` | 步骤未配 `maxTurns` 时的默认轮数（默认 8，1-64） |
| `WORKFLOW_STEP_TIMEOUT_MS` | 步骤未配 `timeoutMs` 时的默认超时（默认 120000） |
| `WORKFLOW_MAX_RETRIES` | 步骤未配 `maxRetries` 时的默认重试次数（默认 0） |
| `WORKFLOW_SANDBOX` | 步骤未配 `sandboxCwd` 时的默认沙箱目录（相对服务器根） |
| `WORKFLOW_VERIFY_TIMEOUT_MS` | verify reviewer / finalVerify 的单次审核超时（默认 60000） |
| `WORKFLOW_ALLOW_NET` | `1` 开启 `fetch_url` 联网（默认关） |
| `WORKFLOW_ALLOW_DANGEROUS` | `1` 放行危险命令（默认拦） |
| `WORKFLOW_TOOLS` | 逗号分隔的服务器级工具白名单，覆盖所有步骤的默认工具集 |

所有默认值、合法区间与启动期告警集中在 `lib/config.mjs` 一处维护；配置自相矛盾（例如只配了 `LLM_BASE_URL` 没配密钥）会在启动时以 **stderr** 告警——stdout 是 JSON-RPC 通道，不会被污染。

## 文件布局

```
server.mjs             MCP stdio 服务器（JSON-RPC 2.0，逐行消息）+ 工具注册与按流加锁
lib/config.mjs         环境变量与默认值（唯一配置入口）
lib/schema.mjs         步骤规范化、创建期结构校验、id/文件名安全化
lib/state.mjs          六态状态机、确定性门控与 READY 推导
lib/planner.mjs        提示词拼装、批次规划、步骤运行时参数解析
lib/render.mjs         WORKFLOW.md 渲染与面向人类的文本
lib/store.mjs          持久化（原子写 / schema 迁移 / 残留 running 回收）+ 工具实现
lib/executor.mjs       方案A 执行编排（并发池/重试/取消/verify/finalVerify）+ 方案B 派发
lib/gate.mjs           布尔门表达式解析与求值
lib/agent.mjs          agent 循环、OpenAI/Anthropic 协议适配、JSON 容错、Schema 校验
lib/agent-tools.mjs    六个内置工具与路径沙箱（不读环境变量，开关由调用方注入）
lib/lock.mjs           按 key 串行化的异步锁
docs/                  需求与升级说明（SPEC.md、UPGRADE-agentic.md）
flows/                 工作流数据（每流 <id>.json + <id>.WORKFLOW.md）；trash/ — 删除归档
```

依赖方向是单向的：`server → executor → store → {state, planner, render, schema} → {gate, config} → agent-tools`，没有环。

## 注册（用户级）

`~/.zcode/cli/config.json`：

```json
{
  "mcp": {
    "servers": {
      "workflow": {
        "command": "node",
        "args": ["E:\\workflow mcp\\server.mjs"]
      }
    }
  }
}
```

可选参数 `--root <dir>` 改变存储位置（默认服务器目录），测试也用它隔离数据。

## 测试

```bash
node test/smoke.mjs         # 旧 10 工具回归 + 归档/恢复闭环 + 非法 id 拒绝
node test/run.test.mjs      # SPEC 验收：并行/门控/失败隔离/续跑/A-B切换/cancel
node test/agentic.test.mjs  # UPGRADE-agentic 验收：agent 循环/沙箱/白名单/outputSchema/verify/finalVerify/Anthropic
node test/harden.test.mjs   # 加固回归：Schema 扩展关键字/串行锁/崩溃续跑/损坏数据/配置默认值
npm test                    # 全部
```

要求 Node >= 20.3（用到 `AbortSignal.any`）。
