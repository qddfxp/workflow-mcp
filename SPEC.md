# 需求：把 workflow-mcp 升级为「确定性编排 + 并行执行」双能力 MCP

> 给搭建/改造这个 MCP 的 agent 的说明。目标：在保留现有确定性状态机全部能力的前提下，新增"自动并行执行"能力，对标 pi 扩展的 workflow 工具。

## 一、现状（已确认，不要改坏）

现有 `server.mjs` + `lib/gate.mjs` + `lib/store.mjs` 实现了一个确定性状态机：

- DAG 步骤图 + 布尔门（`gate`: `&& || !` 括号）+ 断点续跑（`flows/*.json` 持久化）。
- 10 个工具，手动执行循环 `create_workflow → next_step → 做事 → complete_step → ... → validate_workflow`。
- 纯 Node 零依赖、stdio 传输、JSON-RPC 2.0。

**这些能力全部保留，向后兼容。** 已有 `flows/` 数据格式不变（或做 schema 版本迁移，见第五节）。

## 二、要新增的能力（对标 pi 扩展的 workflow 工具）

新增"自动执行模式"：不是只记录状态，而是真正把 READY 步骤派发出去执行——

- 同一条 DAG 上，无依赖关系的 READY 步骤要能**并行**跑；
- 跑完自动 `complete` 并推进门条件；
- 循环直到全部完成或卡住；
- 中途可断点续跑。

## 三、关键架构决策（两个方案都实现，抽象出 executor 接口）

MCP 服务器无法直接调用宿主的子代理，所以执行器抽象成两层：

### 方案A「自含执行器」（self-contained）
服务器直接调 LLM API 执行每步。

- 通过环境变量配置：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_MAX_CONCURRENCY`。
- 每步一个模型调用，独立的 READY 步骤用 `Promise.all` 并行。
- 步骤可覆盖字段 `model` / `timeoutMs` / `maxRetries`。
- 优点：无人值守一键跑完；缺点：服务器进程要管密钥、要引 HTTP 客户端（保持零依赖就用内置 `fetch`）。

### 方案B「宿主驱动」（host-driven，默认）
服务器不调模型，只产出"派发批次"。

- 新增工具返回：当前可并行的步骤分组 + 每步拼装好的提示词 + 上游依赖结果。
- 宿主 agent 拿到后自己并行派子代理执行，跑完用 `complete_step` 回填。
- 优点：零密钥、复用宿主已有的子代理/模型能力；缺点：需要宿主配合循环。

**要求**：内部统一 `executor` 抽象；方案A 未配置密钥时自动退化为方案B。两种模式共用同一套 DAG/门/续跑状态，**不能出现两套状态机**。

## 四、具体功能需求

### 1. 步骤新增可选字段（`create_workflow` 的 steps 项扩展，全部可选，缺省=手动）

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | `"manual" \| "auto"` | 该步人工做还是自动执行，缺省 `manual` |
| `agentPrompt` | string | 自动执行时给子代理/模型的提示词 |
| `model` | string | 仅 auto 步骤生效，覆盖全局模型 |
| `timeoutMs` | number | 仅 auto 步骤生效 |
| `maxRetries` | number | 仅 auto 步骤生效 |

手动步骤保持现有行为：`next_step` 提示、等 `complete_step`。

### 2. 新增工具（核心，命名可微调）

- **`run_workflow { id, maxConcurrency?, mode? }`**
  - 编译当前所有 READY 步骤（尊重 DAG + gate，与现有 `readySteps` 逻辑一致）。
  - 把互不依赖的 READY 步骤按拓扑分组成批次，**批内并行、批间串行**。
  - 每步用方案A 或方案B 执行，拿到结果调 `complete_step`，再推进下一批。
  - 某步失败：按 `maxRetries` 重试，重试仍失败则标记失败并停止该分支（**不要整条流崩**），返回失败步骤清单和原因；其余可继续的分支照常推进。
  - 返回本次执行摘要：完成 / 跳过 / 失败 / 仍卡住的步骤。

- **`dispatch_batches { id }`**（方案B 入口）
  - 返回 `[{ stepIds, prompts, upstreamResults }]`。
  - 每个 stepId 附拼装好的提示词（= 流 `description` + 该步 `title/instruction` + 其直接依赖的结果）。
  - 宿主按批并行执行后逐个 `complete_step` 回填。

- **`cancel_run { id }`**（方案A 有长任务时需要，取消/打断当前 run）

- `get_workflow` 的 json/md 输出里要能看出每步是 `manual/auto` 及执行状态（`done/skipped/failed/running`）。

### 3. 状态机扩展

- schema 版本升到 `2`，旧 `schema=1` 自动兼容/迁移。
- 步骤状态从 `done/skipped` 二态扩展：`pending / ready / running / done / skipped / failed`。
- 现有工具（`next_step` / `complete_step` / `skip_step` / `undo_step` / `workflow_status`）全部照旧可用。
- `failed` 也视为"已落定"参与门条件与 READY 推导。**语义定死**：`failed` 视为布尔 `false`，且**不算 skipped**（在文档里写清）。
- `undo_step` 连下游回退的语义保持不变，同时清掉 `running/failed`。

### 4. 断点续跑

`run_workflow` 中途中断（进程被杀/网络断）后再次调用，能从持久化的 JSON 状态继续，**只补跑未完成的步骤，不重跑已 done 的**。

### 5. 确定性不破坏

门条件仍只在依赖全部落定后求值一次，结果恒定；自动执行只是"谁来填 `complete_step` 结果"的差异，不能引入任何随机重排影响门条件结果。

## 五、验收标准（照这个测）

1. **旧数据兼容**：现有 `test/smoke.mjs` 跑通，10 个旧工具行为不变。
2. **并行正确性**：建一条 `A → (B, C) → D`，A、B、C 为 auto，D 的 gate 依赖 `B && C`；`run_workflow` 后 B、C 确实并行执行（用日志/时间戳证明），D 在两者都完成后才执行。
3. **门控在自动模式下仍生效**：某步 gate 为假被自动跳过，不调模型。
4. **失败隔离**：三路并行里一路失败重试后仍失败，另外两路照常完成，状态里能区分 `done/failed`。
5. **断点续跑**：跑到一半 kill 进程，重启后 `run_workflow` 只补跑未完成步骤。
6. **方案A/方案B 可切换**：不配密钥时 `run_workflow` 走 dispatch 提示；配了密钥时真正自动跑完。

## 六、实现约束

- 保持纯 Node 标准库、零第三方依赖（方案A 的网络调用用内置 `fetch`）。
- 保持 stdio、JSON-RPC 2.0、每行一条消息，不引入新传输。
- 新工具写进测试（扩展 `test/smoke.mjs` 或新增 `test/run.test.mjs`），跑通再交付。
- `README.md` 同步更新：工具表、执行循环两种模式、环境变量、schema 版本。

---

## 附：交付后可选的简化

如果只想保留"宿主驱动"（让 ZCode 里的 agent 自己并行派子代理、MCP 只负责派发批次），可以砍掉方案A（第四节与第六节里所有 `LLM_*` / `fetch` / 自含执行器相关段落），只做方案B + `dispatch_batches`。这样改动更小、不需要管密钥。是否砍，请在开工前明确。
