# 可执行任务清单（MVP）

版本: v0.1  
日期: 2026-02-22  
关联文档: `PROJECT_PLAN.md`

## 0. 任务约定

- 目标: 2-3 周内交付可演示 MVP（本地运行、纯本地存储、支持 3-8 Agent，>=6 默认按轮并发）。
- 原则: KISS/YAGNI 优先，先跑通闭环再扩展；所有规则尽量配置化但不要过度设计。
- Done 定义: 每个任务必须包含可运行/可验证的验收点（Acceptance Criteria），并补齐最少必要的文档说明。
- 依赖约定: 任务内如引入新依赖，必须说明原因与替代方案；避免一次性引入过多复杂基础设施（队列/多进程）。

## 1. 任务清单

### T0. 初始化 Next.js + TypeScript 单仓骨架

目标: 建立可运行的全栈单仓工程、基础质量工具与目录结构。

交付物:

- Next.js App Router 项目初始化（Node.js + TypeScript）。
- 基础脚本: `dev`, `build`, `start`, `test`（如暂未引入测试框架也要留位）。
- 目录建议:
  - `src/app`（页面与 API Route Handlers）
  - `src/lib`（领域/编排/Provider/存储等）
  - `src/styles`（如需要）
- `.env.example`（仅列变量名，不放真实 key）。

验收标准:

- 本地执行 `npm run dev`（或 `pnpm dev`）后能访问首页。
- `README.md` 增加 “Quickstart（本地）” 小节，说明 Node 版本与启动命令。

依赖:

- 无。

---

### T1. 领域模型 + 配置 Schema（Meeting/Message/Vote/Config）

目标: 把系统“可变的部分”统一收敛到配置与类型，后续模块只依赖抽象类型。

交付物:

- TypeScript 类型（建议放 `src/lib/domain/*`）：
  - `Meeting`, `Message`, `Vote`, `AgentConfig`
  - `DiscussionConfig`（含 `mode`、`auto_parallel_min_agents=6`、交叉回应数量、滚动摘要开关与长度上限）
  - `FacilitatorConfig`（默认开启）
  - `OutputConfig`（默认 Markdown，可选 JSON）
  - `ThresholdConfig`（默认 `mode=avg_score`，阈值 80/100）
- 配置校验:
  - 使用 `zod` 或等价方案对 meeting config 做校验与默认值填充（避免散落的默认值逻辑）。

验收标准:

- 创建会议 API 在入参缺省时能补齐默认值（讨论模式 `auto`、facilitator 默认开启、avg_score_threshold=80）。
- 对明显非法配置（例如阈值 >100、agent 数为 0、mode 不在枚举内）会返回可读错误。

依赖:

- T0

---

### T2. 本地存储层（Store 接口 + InMemory + SQLite）

目标: 会议记录纯本地可持久化，同时保留 InMemory 实现便于单测与早期迭代。

交付物:

- `Store` 抽象接口（建议 `src/lib/storage/store.ts`）：
  - `createMeeting/getMeeting/updateMeeting/listMeetings`
  - `appendMessage/listMessages`
  - `appendVote/listVotes`
- 两个实现:
  - `InMemoryStore`（默认用于测试/开发）
  - `SqliteStore`（默认用于本地持久化运行）
- 明确数据库文件位置（例如 `data/ai-meeting.db`），并确保目录不存在时自动创建。

验收标准:

- 创建会议后刷新页面/重启服务，会议与消息仍可读取（SQLite 模式）。
- Store 层写入与读取都带 meetingId 过滤，避免全表扫描式接口。

依赖:

- T1

---

### T3. LLM Provider 抽象 + Mock Provider

目标: 让 orchestrator 只依赖统一 `LLMClient`，并能在不接真实模型时跑完整闭环。

交付物:

- `LLMClient` 接口（建议 `src/lib/llm/types.ts`）：
  - `generateText({ provider, model, messages, temperature, maxTokens, responseFormat, timeoutMs }): { text, usage, raw }`
- `MockProvider`：
  - 可按 `agentId` 输出不同风格的固定模板文本
  - 可模拟超时/错误/非法 JSON（用于集成测试）

验收标准:

- 用 MockProvider 能跑通：Round 0 盲回 -> 若干轮讨论 -> 投票 -> 达标结束/兜底结束。
- Provider 层错误不会导致进程崩溃；错误会被包装成可记录的结构（error code/message）。

依赖:

- T1

---

### T4. Orchestrator 状态机（含讨论模式 auto/serial_turn/parallel_round）

目标: 实现会议编排核心，支持 3-8 Agent，并在 >=6 时默认切换到按轮并发。

交付物:

- Orchestrator 核心模块（建议 `src/lib/orchestrator/*`）：
  - 状态机: `DRAFT -> RUNNING_DISCUSSION -> RUNNING_VOTE -> ...`
  - Round 0 并发盲回（限制输出结构与长度）
  - `serial_turn`：同轮按人串行（建议仅用于 <=5）
  - `parallel_round`：同轮按轮并发（>=6 默认）
- 上下文构造策略（KISS 版本）：
  - 输入尽量使用 “议题 + 滚动摘要 + 最近 N 条消息 + 最新用户插话”
  - `reply_targets`：每个 Agent 每轮必须回应 orchestrator 指定的 1-2 个对手要点
- 消息落盘:
  - 并发轮次生成完成后，按固定顺序写入消息流（保证 UI 阅读体验）。

验收标准:

- 会议配置 `discussion.mode=auto` 时：
  - agentCount=5 -> 使用 `serial_turn`
  - agentCount=8 -> 使用 `parallel_round`
- `parallel_round` 单轮耗时接近“最慢的那个模型”而不是 8 倍串行。
- 每条 agent message 的 meta 中记录 `discussion_mode` 与 `reply_targets`（用于调试与 UI 展示）。

依赖:

- T1, T2, T3

---

### T5. 主持人/收敛器（Facilitator）+ 滚动摘要

目标: 默认开启的“收敛器”在投票未通过时推动收敛；在 `parallel_round` 下每轮生成滚动摘要以控制上下文成本。

交付物:

- Facilitator 调用链（可复用任一 Provider，但配置可独立）：
  - 输入: 当前结论草案 + 最近一轮新增信息 + 主要分歧点（来自摘要或提取）
  - 输出（JSON，带解析与重试）：
    - `disagreements` (1-3)
    - `proposed_patch`（对结论草案的最小改动）
    - `next_focus`（下一轮 1-2 个必答问题）
    - `round_summary`（200-400 字滚动摘要）
- 将 Facilitator 输出写入消息流（建议 `speakerType=system`, `speakerId=facilitator`）。

验收标准:

- `parallel_round` 模式下每轮结束会生成滚动摘要，并在下一轮上下文中使用（不再带全量历史）。
- 投票未通过时一定会生成 `next_focus`，下一轮 prompt 强制围绕这些焦点作答。
- Facilitator 返回非法 JSON 时：至少 1 次“纠错重试”，仍失败则降级为纯文本摘要并记录错误。

依赖:

- T3, T4

---

### T6. 投票/评分管线（并发投票 + 平均分阈值 + 可插拔规则）

目标: 所有 Agent 并发投票，默认平均分阈值达标才结束；为后续其它规则留扩展点。

交付物:

- 投票阶段并发执行（含超时/重试/缺席策略）。
- 默认规则 `avg_score`：
  - 计算平均分 >= 80 且满足 `min_rounds` 才可结束
  - 支持 `max_rounds` 兜底结束
- 规则扩展位（不必一次做全）：
  - 在代码结构上允许新增 `pass_ratio/min_score_threshold` 等而不改动 orchestrator 主流程（OCP）。
- 用户插话中断投票:
  - 当 meeting status 为 `RUNNING_VOTE` 收到用户消息，立刻切回 `RUNNING_DISCUSSION`，并使本轮 in-flight votes 结果失效（建议用 `stageVersion`/`voteRevision` 机制丢弃旧结果，避免复杂取消）。

验收标准:

- 8 Agent 投票阶段总耗时接近单次投票最慢耗时（并发），不会出现串行 8 倍等待。
- 用户在投票阶段插话后：
  - 本轮投票不再进入聚合判定（旧结果即使回来也会被忽略）
  - 下一轮讨论上下文包含该用户插话与 facilitator 的新聚焦点（如开启）

依赖:

- T4, T5

---

### T7. 后端 API + SSE 事件流 + 运行器（Runner）

目标: 前端能创建/启动会议、实时看到消息流、在本地跑完整会议闭环。

交付物:

- API Route Handlers（Next.js）：
  - `POST /api/meetings` 创建会议
  - `GET /api/meetings/{id}` 获取会议
  - `POST /api/meetings/{id}/start` 启动（进入 RUNNING_DISCUSSION）
  - `POST /api/meetings/{id}/user-message` 用户插话（含 vote 中断逻辑）
  - `GET /api/meetings/{id}/events` SSE 推送消息/状态/vote
- Runner（KISS 版本，进程内）：
  - `start` 后自动推进会议（直到结束或达到限制）
  - 提供最小的“停止/终止”能力（例如达到预算或用户手动）

验收标准:

- 前端连接 SSE 后能实时看到：
  - agent messages
  - facilitator messages
  - votes summary/meeting status changes
- Runner 异常（某次模型调用失败）不会卡死会议：按策略重试/跳过/兜底结束。

依赖:

- T2, T4, T6

---

### T8. Web UI（创建 / 进行中 / 结果）

目标: 可演示的完整用户流程，重点体现“像开会”的观感 + 大规模时的速度可控。

交付物:

- 创建页:
  - 议题输入
  - 选择/配置 3-8 个 Agent（provider/model/角色）
  - 讨论模式 `auto|serial_turn|parallel_round`（默认 auto；>=6 提示将按轮并发）
  - 主持人/收敛器开关（默认开启）
  - 输出选项：默认 Markdown，可选 JSON
- 进行页:
  - 消息时间线（区分 user/agent/system）
  - 用户插话输入框（投票阶段插话会提示“已中断投票回到讨论”）
  - 当前 round、当前模式、当前阈值与进度
- 结果页:
  - Markdown 纪要展示
  - 可选 JSON 下载/展开查看

验收标准:

- 从 UI 完整跑通：创建 -> 开始 -> 多轮 -> 投票 -> 结束 -> 查看结果。
- 8 Agent 场景下 UI 不出现“2 分钟空白等待”，消息能持续流入（SSE）。

依赖:

- T7

---

### T9. 接入真实 Provider（OpenAI-compatible / Claude / Gemini）

目标: 在统一抽象下接入三类供应商接口，并确保最小可用的容错与观测。

交付物:

- Provider 实现（支持 `baseUrl`，用于第三方兼容网关）：
  - OpenAI-compatible
  - Anthropic Claude
  - Google Gemini
- 统一超时/重试策略（最小版本）：
  - 每次调用超时（例如 60s）
  - JSON 期望输出的场景（vote/facilitator）允许 1 次纠错重试
- 记录 usage meta（如可获取）与 requestId，写入 Message/Vote meta。

验收标准:

- 配置任一真实 Provider + 模型后，能完成一次会议并产出结果（Markdown，JSON 可选）。
- 任一 Provider 临时失败时会议能继续推进（跳过/重试/缺席票策略生效），不会一直卡在 RUNNING 状态。

依赖:

- T3, T7

---

### T10. 测试 + 文档 + 演示脚本

目标: 关键规则可回归验证，项目可被第三方在本地快速跑起来演示。

交付物:

- 单元测试（至少）：
  - 阈值判断（avg_score）
  - `auto` 模式切换逻辑（<=5 串行 / >=6 并发）
  - vote 中断与 in-flight 结果失效（revision 机制）
- 集成测试（至少 1 条）：
  - MockProvider 模拟 8 agent 并发 + 1 个超时 + 1 个非法 JSON，会议仍能兜底完成
- 文档：
  - `README.md`：环境变量、如何跑 mock、如何跑真实 provider、如何复现 8 agent 场景
  - `PROJECT_PLAN.md` / `TASKS.md` 保持一致（如有变更同步更新）

验收标准:

- `npm test`（或 `pnpm test`）可运行并通过（至少覆盖上述关键用例）。
- 新人按 README 在 15 分钟内可跑通 mock 演示。

依赖:

- T4, T6, T7

