# 升级需求：把方案A 从「裸 LLM 单轮调用」升级为「步骤内 Agent 循环」

> 前置：本文件在 `SPEC.md`（已完成的"双能力"改造）基础上，进一步把自动执行做得更像扩展 workflow 的子代理。

## 一、目标

让每个 `auto` 步骤不再是"一次 prompt → 一段文本"，而是一个**能在步骤内读文件、跑命令、写文件、联网、多轮思考的小 agent**。这样 auto 步骤就能像扩展 workflow 的子代理一样真正"干活"，而不是只会输出文字。

## 二、先说清天花板（为什么不能 100% 变成扩展那种）

MCP 服务器是宿主拉起的一个独立 stdio 子进程，**无法调用宿主的子代理系统**（pi 的 `agent()` 住在宿主运行时里）。它只能在自身进程内用 Node 的能力（`fs` / `child_process` / `fetch`）搭"迷你 agent"。这决定：

- ✅ 能实现：步骤内多轮工具调用、读写文件、跑命令、联网、结构化输出、质量校验——功能上逼近子代理。
- ❌ 做不到：继承宿主的上下文/工具/模型/权限；不能真正"派宿主子代理"。

因此本次升级 = **把方案A 升级成"服务器内 agent 循环"**；方案B（交还宿主派发）保持不动。

## 三、核心改动：步骤内 Agent 循环（工具调用循环）

把 `executor.mjs` 里的 `callLLM`（单轮）替换为 `agentLoop`（多轮）：

1. 首轮请求带 `tools` 定义 + system/user 提示词（`agentPrompt` + 上游依赖结果 + 工作目录）。
2. 模型返回 `tool_calls` → 服务器在 Node 里执行对应工具 → 结果作为 `role:"tool"` 消息回喂 → 循环。
3. 直到模型给出最终文本（`finish_reason=stop` 且无 `tool_calls`），或达到 `maxTurns`（默认 8）/ 超时。
4. 最终文本作为步骤 `result`；工具副作用（写入的文件）保留在磁盘。

**协议适配要求**：需支持函数调用协议。若 `LLM_BASE_URL` 是 OpenAI 兼容端点（如 BigModel 的 `paas/v4`），用 `tools`/`tool_calls`；若是 Anthropic 兼容端点（如 `open.bigmodel.cn/api/anthropic`），需实现对应的 `tool_use`。建议 executor 抽象一层 protocol 适配器，别写死一种。

## 四、新增工具集（服务器内，Node 标准库实现，仅供 agent 循环内部使用，不对外暴露）

| 工具 | 说明 |
|---|---|
| `read_file { path }` | 读文件，限定在沙箱目录内 |
| `write_file { path, content }` | 写文件 |
| `list_dir { path? }` | 列目录 |
| `grep { pattern, path? }` | 搜索文件内容 |
| `bash { command }` | `child_process` 执行，带超时 + 输出截断 |
| `fetch_url { url, method? }` | 内置 `fetch`（可开关） |

## 五、新增步骤字段（`create_workflow` 扩展，全部可选）

| 字段 | 类型 | 说明 |
|---|---|---|
| `tools` | string[] | 该步允许的工具白名单（缺省 = 按 env 默认） |
| `maxTurns` | number | agent 循环最大轮数（默认 8） |
| `outputSchema` | object | 期望的结果 JSON schema，输出不符则重试一轮 |
| `verify` | string | 完成后对该步 result 的布尔断言（如 `"ok === true"`）或 reviewer 提示词 |
| `sandboxCwd` | string | 该步允许访问的目录（缺省 = 工作流 root） |

## 六、质量助手（对标扩展的 verify / judgePanel / completenessCheck）

- **步骤级 reviewer**：配了 `verify` 后，步骤完成后额外调一次模型审结果，返回通过/不通过；不通过则记 `failed` 或按配置重跑一次。
- **流程级 final_verify**：全部 done 后，把汇总结果丢给模型做整体一致性检查。

## 七、并行 / 重试 / 续跑（复用现有，不重做）

批内并行、批间串行、`maxRetries`、失败隔离、断点续跑、`cancel_run` 全部保持现有实现，**只把"单轮 callLLM"换成"agentLoop"**，其余逻辑不动。

## 八、安全沙箱（必须做，否则危险）

- 所有工具路径规范化后强制限定在 `sandboxCwd`（默认工作流 root）内，拒绝 `../` 逃逸。
- `bash` 默认拦截危险命令（`rm -rf` / `del /s` / `rd /s` / `format` / 注册表 / `shutdown` 等），env `WORKFLOW_ALLOW_DANGEROUS=1` 才放行。
- 默认禁止写工作流目录以外的文件；`fetch_url` 默认关闭，env `WORKFLOW_ALLOW_NET=1` 开启。

## 九、验收标准（照这个测）

1. **真读了文件**：auto 步骤 `agentPrompt="读取 lib/store.mjs，统计它导出了几个函数，把数字写入 out.txt"`，`run_workflow` 后 `out.txt` 真实存在且内容正确。
2. **真多轮**：一个需要"先 grep 再 read 再 write"的步骤，模型发起 ≥2 次 `tool_calls` 且最终成功。
3. **路径逃逸被拦**：步骤尝试 read 沙箱外路径时返回拒绝，不崩溃。
4. **危险命令被拦**：`bash "rm -rf /"` 被拦截并记录。
5. **verify 生效**：断言不通过 → 步骤标记 `failed`（或按配置重跑一次）。
6. **旧功能回归**：`test/smoke.mjs` + `test/run.test.mjs` 全部仍通过。
7. **outputSchema 生效**：要求 `{ ok:boolean, n:number }`，模型输出不符时能重试/纠正。

## 十、实现约束

- 仍零第三方依赖、stdio、JSON-RPC 2.0。
- agent 循环的 `tool_calls` 解析要健壮（模型输出可能格式漂移，需容错：截断、非 JSON、字段缺失等）。
- 新增工具/字段要同步进 `create_workflow` 的 `inputSchema` 和 `README.md`。
- 新增 `test/agentic.test.mjs`（mock LLM 按脚本返回预设 `tool_calls` 序列，验证循环/沙箱/断言）。

---

## 附：建议分期交付（避免一次改太大）

- **第 1 期（核心）**：agent 循环 + 六个内置工具 + 安全沙箱。跑通验收 1-4、6。
- **第 2 期（质量）**：`verify` / reviewer / `outputSchema` / `final_verify`。跑通验收 5、7。
- **第 3 期（可选）**：token/cost 预算、`fetch_url` 联网开关细化、协议适配层重构。

第 1 期做完就能明显感到"步骤会自己动手了"，是性价比最高的一段。
