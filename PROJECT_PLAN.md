# 多 AI 多模型议题讨论系统：项目开发计划

版本: v0.1 (草案)  
日期: 2026-02-22  
作者: 项目组

## 1. 背景与目标

用户创建一个议题/想法/需求后，系统拉起多个 AI 模型作为“参会者”进行讨论。每个模型能看到其它模型的发言，并在多轮讨论后对“当前结论”进行评分/投票。只有当评分/票数达到预设基准值时会议才结束；否则继续讨论，直至满足结束条件或触发安全兜底条件（例如最大轮次/预算）。

### 1.1 项目目标 (Goals)

- 支持“一个用户 + 多个 AI 参会者”的会议式讨论流程。
- 支持多模型/多供应商 (Providers) 的统一接入与配置。
- 支持可解释、可配置的结束机制：投票/评分阈值 + 继续讨论循环。
- 为每场会议产出结构化结果：结论摘要、主要分歧点、行动项、投票记录。

### 1.2 非目标 (Non-goals, MVP 不做)

- 不做复杂 RAG/知识库检索、文件上传讨论、长文档协作编辑。
- 不做多用户实时协作（先单用户驱动）。
- 不做“自动工具调用/外部系统执行”（先纯讨论与总结）。
- 不做复杂工作流编排（先固定状态机 + 可配置参数）。

## 2. 角色与核心用例

### 2.1 角色

- 用户: 创建议题、选择参会模型、设置阈值/轮次、发起会议、查看结果。
- AI 参会者 (Agent): 基于角色设定参与讨论，阅读其它发言，提出观点/质疑/改进建议，最终投票。
- 会议编排器 (Orchestrator): 控制回合、上下文、投票、阈值判断与结束。

### 2.2 核心用例 (User Stories)

- 作为用户，我能创建一个议题并配置多个 AI 模型参与讨论。
- 作为用户，我能看到每个模型在每一轮的发言、以及其它模型的观点如何影响它的后续发言。
- 作为用户，我能设置结束条件（例如平均分阈值、赞成票比例、最少轮次、最大轮次）。
- 作为用户，我能在会议进行中随时插入发言以引导/补充/纠偏，且该发言会被后续模型发言与投票纳入上下文。
- 作为用户，我能选择是否启用“主持人/收敛器”来加速达成共识（默认开启）。
- 作为用户，我能在会议结束后得到一个可复制的“会议纪要式结果”，并查看每个模型的投票/评分理由。

## 3. 需求澄清与关键决策点

本计划基于以下假设；如与你的真实需求不符，应先在启动开发前确认。

- 会议参与者数量: 3-8 个为常见范围（太多会显著增加成本与上下文压力）。
- 投票方式: 每个 Agent 输出一个数值评分 (0-100) + 是否结束 (pass/fail) + 简短理由。
- 讨论方式: 每轮让所有 Agent 依次发言（顺序可固定或轮换），每个 Agent 都能看到截至当前的完整会议记录（必要时由系统生成“上下文摘要”以压缩）。
- 供应商接入: 首批接入 OpenAI 兼容、Anthropic Claude、Google Gemini 三类接口，后续可扩展。
- 存储: 会议记录暂时纯本地（单机），MVP 不做云端多租户；可用 SQLite 作为本地持久化介质。

已确认：

- 会议进行中允许用户插话/补充信息引导方向；插话会进入消息流，并影响后续 Agent 发言与投票。
- 用户插话发生在 `RUNNING_VOTE` 时：默认中断本轮投票并回到 `RUNNING_DISCUSSION`（可配置）。
- 首批要接入的供应商接口: OpenAI 兼容、Claude 格式、Gemini 格式。
- 会议记录暂时纯本地（默认不做登录/多租户/云端同步）。
- 技术栈: Next.js + TypeScript（全栈单仓）。
- 投票阈值规则默认采用“平均分”模式（仍可切换其它规则组合）。
- “平均分模式”的默认通过阈值暂定为 80/100（可在会议配置中调整）。
- 结果产出格式默认 Markdown，用户可选是否同时输出结构化 JSON。
- “主持人/收敛器 Agent”作为可选项由用户决定是否开启（默认开启）；不参与投票、不裁决，仅在投票未通过时输出分歧点、对结论草案的最小修订建议与下一轮讨论焦点。

## 4. 会议流程设计 (状态机)

### 4.1 状态机

- `DRAFT`: 创建会议、配置参会者与参数。
- `RUNNING_DISCUSSION`: 多轮讨论进行中。
- `RUNNING_VOTE`: 触发投票/评分阶段。
- `FINISHED_ACCEPTED`: 达到阈值，会议正常结束。
- `FINISHED_ABORTED`: 触发兜底结束（最大轮次/预算/超时/用户手动结束）。

核心流转：

`DRAFT -> RUNNING_DISCUSSION -> RUNNING_VOTE -> (FINISHED_ACCEPTED | RUNNING_DISCUSSION)`

### 4.2 讨论轮次策略 (Round Strategy)

本项目存在两条路线：模拟真实群聊（更有“交锋感”）与按轮并发的信息压缩（更快、更省、更稳定）。MVP 采用折中方案：保留“群聊观感”，但在参与者较多时使用按轮并发以避免等待时间与上下文爆炸。

讨论模式（建议做成可配置，默认 `auto`）：

- `auto`（默认）：Agent 数 <= 5 使用 `serial_turn`；Agent 数 >= 6 使用 `parallel_round`。
- `serial_turn`：同一轮内按人串行发言（更像真人群聊，适合 3-5 人）。
- `parallel_round`：同一轮内所有 Agent 并发发言（适合 6-8 人，性能与成本更可控）。

首轮策略（两种模式通用）：

1. Round 0 并发“盲回”：所有 Agent 同时给出初始观点/方案（限制输出长度与结构，避免首轮长文）。
2. 生成“滚动摘要/分歧点”：用主持人/收敛器（或独立摘要器）把 Round 0 压缩为可读的关键信息（供后续轮次使用）。

`serial_turn`（小规模，wow factor）：

1. Orchestrator 选择发言顺序（固定或轮换）。
2. 每位 Agent 的输入上下文以“议题 + 滚动摘要 + 最近 N 条发言 + 用户插话”为主（避免全量历史）。
3. 依次调用每个 Agent 生成本轮发言（用户若在中途插话，最早会在下一位 Agent 发言时生效）。
4. 记录发言并广播到前端。

`parallel_round`（大规模，MapReduce-lite）：

1. Orchestrator 为每个 Agent 构造“紧凑上下文”：议题 + 滚动摘要 + 最新用户插话 + 本轮必须回应的 1-2 个“对手要点”（定向交叉回应）。
2. 并发调用所有 Agent 生成本轮发言；完成后按固定顺序写入消息流（保证 UI 可读）。
3. 用主持人/收敛器生成新的滚动摘要、主要分歧点与结论草案最小修订（避免上下文指数级增长）。

定向交叉回应（两种模式都建议启用）：

- 每个 Agent 每轮必须明确回应 1-2 个其它 Agent 的具体要点（由 orchestrator 选定要点或引用摘要中的条目），以减少“附和/复读”。

### 4.3 投票阶段 (Vote)

1. Orchestrator 构造“当前结论草案”（可由系统总结生成）。
2. 并发请求所有 Agent 对该结论进行评分/投票（设置超时与重试；个别缺席按配置处理）。
3. 汇总结果，判断是否达到阈值：
    - 达到: 输出最终纪要，进入 `FINISHED_ACCEPTED`
    - 未达: 进入下一轮讨论；若开启主持人/收敛器，则生成“未通过原因 + 最小修订建议 + 下一轮焦点”并写入消息流，作为下一轮的强引导

### 4.4 用户中途发言 (Steering Message)

- 允许在 `RUNNING_DISCUSSION` 期间随时发送用户消息；系统把它作为 `speakerType=user` 的 Message 写入消息流。
- 不强行中断正在进行的模型调用；用户消息会在“下一次可用的 Agent 发言/投票输入”中被纳入上下文（KISS，避免复杂取消机制）。
- 默认策略：若在 `RUNNING_VOTE` 收到用户插话，则中断本轮投票、回到 `RUNNING_DISCUSSION`，并以该插话作为下一轮讨论重点（可配置为“排队到下一轮/不影响当前投票”）。

### 4.5 主持人/收敛器 (Facilitator, 默认开启)

定位：它不是“裁判”，无一票否决/强制结束权；其职责仅是帮助讨论收敛、减少跑满 `max_rounds` 的概率。

触发时机（默认）：

- `RUNNING_VOTE` 未通过 -> 生成一条主持人消息并进入下一轮讨论。
（推荐）在 `parallel_round` 模式下，每轮结束后也生成一次“滚动摘要/分歧点”，用于上下文压缩与下一轮聚焦。

输出内容（建议结构化 JSON，便于强约束与 UI 展示）：

- `disagreements`: 1-3 条主要分歧点
- `proposed_patch`: 对“当前结论草案”的最小改动建议（避免推倒重来）
- `next_focus`: 下一轮必须聚焦的 1-2 个问题

滚动摘要建议额外包含：

- `round_summary`: 200-400 字，覆盖本轮新增信息与变化点

会议记录呈现：

- 主持人输出写入消息流，建议用 `speakerType=system` 且 `speakerId=facilitator`（不计入投票人数）。

## 5. 投票/评分规则 (可配置)

建议用组合规则，既能收敛也能防止“平均分虚高”：

- `min_rounds`: 最少讨论轮次，避免过早结束（例如 2）。
- `max_rounds`: 最大讨论轮次，兜底（例如 8）。
- `mode`: 阈值模式（默认 `avg_score`）。
- `avg_score_threshold`: 平均分阈值（默认 >= 80/100）。
- `pass_ratio`（可选）: 赞成票比例阈值（例如 >= 0.75）。
- `min_score_threshold`（可选）: 任一模型低于此分则不能结束（例如 < 60 则否决）。

默认结束条件示例：

- `mode=avg_score` 且 平均分 >= 80 且 已达最少轮次

兜底条件示例：

- 达到最大轮次/最大 token 预算/最大费用预算/超时 -> `FINISHED_ABORTED`，仍输出“最佳可用结论 + 未达成共识原因”。

## 6. 系统架构 (建议)

### 6.1 总体结构

- 前端 Web: 议题创建、参会者配置、实时会议流、投票面板、会议结果页。
- 后端 API: 会议状态机、消息存储、权限/限流、预算控制。
- Orchestrator: 会议编排核心（可作为后端服务内模块；后期可拆成独立 worker）。
- LLM Provider 适配层: 统一调用接口，支持多供应商/多模型。
- 数据库: 会议、消息、投票、配置持久化。

### 6.2 技术栈 (MVP, 已确定)

为了 KISS，采用单仓全栈：

- Node.js + TypeScript
- Next.js（前端 + Route Handlers/API）
- SQLite（本地持久化）+ ORM（可选，例如 Prisma/Drizzle）

## 7. 模块拆分 (按职责)

遵循 SRP/SOLID，把变化点隔离（尤其是多 Provider、多模型、多提示词）。

- `orchestrator`: 会议状态机、轮次推进、投票触发与阈值判断。
- `llm`: Provider 抽象与实现（OpenAI-compatible/Claude/Gemini 等）。
- `prompts`: 提示词模板与渲染（讨论模板、投票模板、总结模板）。
- `storage`: 数据访问层（Meeting/Message/Vote/Round）。
- `api`: 对外 HTTP 接口（创建会议、写入用户消息、启动/暂停、拉取流）。
- `ui`: 会议配置与实时展示。
- `observability`: 日志、指标、trace（至少日志 + requestId）。

## 8. 数据模型草案 (MVP)

建议最小字段，后续扩展保持向后兼容。

### 8.1 Meeting

- `id`
- `title`
- `topic` (用户输入)
- `status` (`DRAFT|RUNNING_DISCUSSION|RUNNING_VOTE|FINISHED_ACCEPTED|FINISHED_ABORTED`)
- `config` (JSON: agents, thresholds, limits, discussion, facilitator, output)
- `createdAt`, `updatedAt`

### 8.2 AgentConfig

- `agentId` (逻辑 id)
- `displayName`
- `provider` (openai-compatible|anthropic|gemini|...)
- `model`
- `systemPrompt` (角色设定)
- `enabled`

### 8.3 Message

- `id`
- `meetingId`
- `roundIndex`
- `speakerType` (`user|agent|system`)
- `speakerId` (user 或 agentId)
- `content` (markdown)
- `createdAt`
- `meta` (JSON: token_usage, latency_ms, provider_request_id, discussion_mode, reply_targets...)

### 8.4 Vote

- `id`
- `meetingId`
- `roundIndex`
- `agentId`
- `score` (0-100)
- `pass` (boolean)
- `reason` (简短文本)
- `createdAt`

### 8.5 FacilitatorConfig (可选)

- `enabled` (默认 true)
- `provider` (openai-compatible|anthropic|gemini，可选；不填则复用默认 provider)
- `model` (可选)
- `systemPrompt` (可选，主持人风格/约束)

### 8.6 DiscussionConfig

- `mode` (`auto|serial_turn|parallel_round`，默认 `auto`)
- `auto_parallel_min_agents` (默认 6；Agent 数 >= 该值时自动启用 `parallel_round`)
- `cross_reply_targets_per_agent` (默认 2；每轮强制回应其它 Agent 的要点数量)
- `rolling_summary_enabled` (默认 true；建议在 `parallel_round` 下强制开启)
- `rolling_summary_max_chars` (默认 800-1200；用于控制上下文长度)

## 9. API 设计草案 (MVP)

保持简单，先 REST + SSE（或 WebSocket）实现实时流。

- `POST /api/meetings` 创建会议 (topic, config)
- `GET /api/meetings/{id}` 获取会议详情
- `POST /api/meetings/{id}/start` 启动会议（进入 RUNNING_DISCUSSION）
- `POST /api/meetings/{id}/user-message` 用户插话/补充信息（会议进行中可用；默认可中断投票回到讨论）
- `POST /api/meetings/{id}/advance` 推进一次“轮次/阶段”（由后端驱动也可）
- `GET /api/meetings/{id}/events` SSE 推送消息与状态变更

注：如果使用“后端自动跑完整会议”，则 `advance` 可隐藏，`start` 后后台 worker 自行推进。

## 10. LLM Provider 抽象 (接口草案)

为避免 DRY，所有模型调用都走统一接口，Provider 只关心自身鉴权与请求格式。

- 首批 Provider 类型:
  - OpenAI 兼容（可配置 `baseUrl`，用于接入第三方 OpenAI-compatible 网关）
  - Anthropic Claude
  - Google Gemini

- `LLMClient.generateText(input): { text, usage, raw }`
- `input` 包含:
  - `messages` (system/user/assistant 结构)
  - `model`, `temperature`, `maxTokens`
  - `responseFormat`（可选，用于要求 JSON）

## 11. 提示词与输出约束

### 11.1 讨论提示词 (Discussion Prompt)

约束目标：

- 每轮只提出 1-3 个核心观点，避免冗长。
- 必须回应 orchestrator 指定的 1-2 个“对手要点/reply targets”（或引用摘要中的其它 Agent 要点），确保真正发生交叉讨论而非复读。
- 若不同意，必须给出可执行替代方案。

### 11.2 投票提示词 (Vote Prompt)

建议强制结构化输出（JSON），便于解析与存储：

- `score`: 0-100
- `pass`: true/false
- `reason`: string (<= 300 字)
- `missing`: array (仍缺什么信息/实验/证据)

### 11.3 主持人/收敛器提示词 (Facilitator Prompt)

目标：在“投票未通过”时，提取分歧点并提出结论的最小修订建议，明确下一轮只讨论 1-2 个焦点以收敛。

建议输出 JSON（用于解析与展示）：

- `disagreements`: array<string>
- `proposed_patch`: string
- `next_focus`: array<string>

## 12. MVP 范围定义 (可交付)

### 12.1 MVP 必须包含

- 创建会议：议题文本 + 选择 3-5 个 Agent（模型/角色）+ 阈值参数。
- 会议执行：多轮讨论 + 投票循环 + 达标结束/兜底结束。
- 讨论模式：支持 `auto|serial_turn|parallel_round`；默认 `auto`，当 Agent 数 >= 6 时使用“按轮并发 + 滚动摘要 + 定向交叉回应”以控制等待时间与上下文成本。
- 用户中途发言：会议进行中用户可插话引导方向，后续 Agent 发言/投票会纳入该信息。
- 主持人/收敛器（默认开启，可关闭）：投票未通过时输出“分歧点 + 最小修订建议 + 下一轮焦点”，推动收敛。
- 结果产出：最终总结、分歧点列表、行动项、投票表。
- 基础成本控制：最大轮次 + 每场会议 token/费用上限（估算即可）。

### 12.2 MVP 明确不包含

- 多人协作、权限系统、团队空间。
- 高级可视化（先做可用的会议时间线/列表）。
- 模型工具调用、外部执行。

## 13. 里程碑与任务拆分 (建议 2-3 周做出可演示版)

以下以“单人/小团队快速迭代”为假设，可按实际人力调整。

### Milestone 0: 项目骨架 (1-2 天)

- 初始化仓库结构与基本运行脚本
- 定义核心数据结构与状态机枚举

验收：

- 本地可启动（即使只有 CLI/空页面）
- 能创建一个 Meeting 记录（内存/SQLite 均可）

### Milestone 1: Orchestrator + Provider Stub (2-4 天)

- 完成会议状态机与轮次推进
- 落地讨论模式选择：`auto|serial_turn|parallel_round`，并实现 Agent 数 >= 6 自动切换到按轮并发
- 实现“滚动摘要”与“定向交叉回应”输入构造（保证并发轮次仍具备交锋感）
- 支持会议运行中追加用户插话，并影响后续轮次/投票输入
- 实现可选的主持人/收敛器步骤（默认开启，可在 meeting config 关闭）
- Provider 先用 mock/stub（固定回复）跑通全流程
- 投票聚合与阈值判断实现

验收：

- 不接任何真实模型，也能跑完：讨论 -> 投票 -> 结束/继续
- 产生完整会议记录与投票记录

### Milestone 2: 接入真实 Provider（先跑通 1 个，再补齐 3 类）(2-4 天)

- 接入 OpenAI 兼容 + Claude + Gemini（至少先跑通其中 1 个，再补齐其余两类）
- 记录 token/延迟等 meta
- 增加失败重试与超时处理（简单策略即可）

验收：

- 真实模型可发言、可投票
- 限流/失败时不会卡死会议（进入兜底或可重试）

### Milestone 3: Web UI (3-6 天)

- 会议创建页（议题 + 参会者配置 + 阈值参数）
- 会议创建页提供“主持人/收敛器开关”（默认开启）
- 会议创建页提供“讨论模式”选择（默认 `auto`；当 Agent 数 >= 6 时提示将采用按轮并发以提升速度并控制成本）
- 会议进行页（消息流 + 用户随时插话输入框 + 当前轮次/阶段 + 投票结果）
- 会议结果页（总结/行动项/投票表）

验收：

- 从 UI 可完整走通：创建 -> 开始 -> 结束 -> 查看结果

### Milestone 4: 持久化 + 预算控制 (2-4 天)

- SQLite/PG 持久化 Meeting/Message/Vote
- token/费用预算估算与硬停止

验收：

- 刷新页面不丢会议信息
- 达到预算会自动终止并输出原因

## 14. 质量保障与测试计划

### 14.1 单元测试 (优先)

- 阈值判断：平均分/赞成比例/否决规则
- 状态机：合法状态转移、兜底结束
- 讨论模式选择：`auto` 下按 Agent 数正确切换 `serial_turn/parallel_round`
- 上下文策略：滚动摘要长度上限、最近 N 条消息截断策略正确
- 提示词渲染：变量替换正确、输出格式校验

### 14.2 集成测试

- 用 Provider mock 复现：模型超时/失败/返回非法 JSON 的处理
- 并发轮次：8 Agent 并发生成时不会被单个超时拖死（重试/降级/缺席策略生效）

### 14.3 端到端测试 (可选)

- 创建会议 -> 跑 2 轮 -> 投票 -> 结束 的 happy path

## 15. 安全与合规 (MVP 基线)

- API Key 不写入日志；敏感字段脱敏。
- 请求限流（按 IP 或用户）。
- 会议内容存储加开关（演示环境可关闭落盘）。
- 兜底结束条件避免“无限循环讨论”导致成本失控。

## 16. 风险与应对

- 共识难以达成：设置 `max_rounds`，默认启用主持人/收敛器在未通过时输出“最小修订 + 聚焦点”推动收敛。
- 8 Agent 串行等待时间过长：默认 `auto` 模式下当 Agent 数 >= 6 切换到 `parallel_round`（按轮并发），并限制每轮输出长度。
- 上下文过长：启用滚动摘要（每轮更新），并在 prompt 中只带“摘要 + 最近 N 条 + 关键引用”，避免全量历史堆叠。
- 多 Provider 行为不一致：通过统一输出格式与解析校验降低波动。
- 成本不可控：token/费用预算 + 失败重试上限 + 缓存（可选）。
- 用户频繁插话导致难收敛：允许配置“最少轮次 + 强制进入投票”的节奏，并在未通过时只聚焦 1-2 个关键分歧点继续讨论。

## 17. 原则落地说明 (KISS / YAGNI / DRY / SOLID)

- KISS: 用小型状态机 + 固定轮次策略先跑通闭环；UI 先做三页（创建/进行/结果）。
- YAGNI: MVP 不做多用户协作、RAG、工具调用，把“讨论+投票闭环”做扎实。
- DRY: Provider 统一接口、提示词集中管理、投票聚合独立模块，避免到处散落规则。
- SOLID:
  - SRP: orchestrator / provider / storage / ui 职责清晰。
  - OCP: 新增模型供应商通过实现 Provider 接口扩展，不改 orchestrator。
  - ISP: Provider 接口只暴露必要能力（generateText），避免“胖接口”。
  - DIP: orchestrator 依赖抽象 Provider/Storage，不依赖具体实现。

## 18. 下一步 (落地实现)

已确认（当前默认实现方向）：

- 首批 Provider: OpenAI 兼容、Claude、Gemini。
- 存储: 会议记录纯本地（MVP 不做登录/多租户/云端同步）。
- 投票阈值: 默认平均分模式（可切换其它规则组合）。
- 平均分阈值: 暂定 80/100（可调整）。
- 结果产出: 默认 Markdown，用户可选输出结构化 JSON。
- 主持人/收敛器: 可选项（默认开启，可关闭），不参与投票、不裁决，仅做收敛引导。

下一步建议（不阻塞，可并行推进）：

1. 基于本计划生成“可执行任务清单”（按模块拆分、每项含验收标准）。
2. 落地工程骨架：初始化 Next.js + TS 单仓结构、定义核心类型/状态机、实现 Provider 接口与 mock，先跑通闭环。
