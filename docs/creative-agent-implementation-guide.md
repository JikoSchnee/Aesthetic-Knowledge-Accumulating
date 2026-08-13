# 图片创作 Agent 与 3D 商品预览实施指南

> 状态：设计与实施说明。本文不包含已执行的实现变更。

## 1. 目标

在现有 Taste Skill Studio 中加入一个创作 Agent，完成以下闭环：

1. 用户上传参考图片并输入 Prompt。
2. Agent 识别意图与图片用途。
3. 从本地、已批准的视觉 Skill 知识库中检索匹配项。
4. 结合用户要求、图片与 Skill 生成主结果图。
5. 将主图应用到马克杯与 T 恤的 3D 商品预览。
6. 用户可拖动、缩放、旋转图案。
7. 用户可导出主图、商品 PNG 预览与布局参数。

首版面向团队内网：使用共享口令和昵称；任务与临时资产不做长期持久化。

## 2. 端到端流程

```text
用户图片 + Prompt
        │
        ▼
Creative Agent
        │  ├─ 识别意图 / 图片用途
        │  ├─ 构造检索查询
        │  └─ search_visual_skills
        ▼
已批准的本地 Skill 知识库
        │
        ▼
选中一个 Skill + 生成结构化 AgentPlan
        │
        ▼
OpenAI 图像编辑模型
        │
        ▼
主结果 PNG
   ┌────┴────┐
   ▼         ▼
马克杯 3D   T 恤 3D
   └────┬────┘
        ▼
拖动 / 缩放 / 旋转 / 导出
```

## 2.1 Agent Harness：六层架构

Harness 不是单独的一层目录或一个 SDK 包，而是这套 Agent 的运行骨架。它应贯穿从用户输入到产物导出的完整链路；其中第六层作为横切层，约束并观测前五层。

```text
L1 交互与会话
        ↓
L2 上下文与状态
        ↓
L3 推理与规划
        ↓
L4 知识与工具
        ↓
L5 执行与产物

L6 治理、可靠性与评估 ───────── 横切 L1–L5
```

| 层级 | 在本项目中负责什么 | 应体现的模块与接口 |
| --- | --- | --- |
| L1. 交互与会话层 | 接收图片与 Prompt，展示阶段、结果与重试操作；建立团队成员身份。 | `app/agent-studio.tsx`、`app/agent.css`、`POST /api/auth/session`、上传校验与 SSE 客户端。 |
| L2. 上下文与状态层 | 把一次创作统一为可追踪的 Run：原图、Prompt、意图、候选 Skill、选中 Skill、结果图和布局。首版只保留临时状态。 | `AgentRunState`、`AgentPlan`、`run-store.ts`、`POST/GET /api/agent/runs`、Run TTL 清理。 |
| L3. 推理与规划层 | 识别 `sourceUsage`，形成检索查询，决定背景策略，并选择本次生成要遵守的视觉规则。只产出受 Schema 约束的计划，不直接生成图片。 | `creative-agent.ts`、`schemas.ts`、`POST /api/agent/plan`、`AgentIntent`、`generationBrief`。 |
| L4. 知识与工具层 | 以受限工具调用项目知识库，只返回已批准、活跃版本的 Top 3 Skill；保证 Agent 无法任意读取本地文件。 | `tools.ts`、`search_visual_skills`、`retrieveSkills()`、搜索文档、索引诊断与修复。 |
| L5. 执行与产物层 | 将计划编译成图像提示词，调用图像模型，保存主图；再把主图用于杯子、T 恤的 3D 贴图、快照和布局 JSON。 | `generation-prompt.ts`、`artwork-generation.ts`、`product-placement.ts`、`ProductMockup.tsx`、导出接口。 |
| L6. 治理、可靠性与评估层 | 防止越权、超额、失控或不可诊断的执行：权限、并发、大小限制、内容/API 错误、重试、日志、测试和回收。 | Session 所有权检查、Origin 检查、文件魔数验证、并发阈值、SSE 事件、Retry、TTL、单元/API/人工验收。 |

### 六层如何落到一次请求

以“上传宠物照片，做一张可印在 T 恤上的插画”为例：

1. **L1** 接收图片与 Prompt，并通过 Session 识别发起者。
2. **L2** 创建 `AgentRunState`，保存本次输入和阶段变更。
3. **L3** 判断为 `preserve_subject`，生成检索查询与透明底倾向。
4. **L4** 通过 `search_visual_skills` 返回 Top 3 已批准 Skill，Agent 只能从其中选择。
5. **L5** 生成主图，并将它作为 T 恤胸前印花和马克杯杯身贴图的唯一来源。
6. **L6** 在整个过程中限制上传大小、验证文件类型与任务归属，记录失败阶段，并按策略重试或清理临时资产。

### 设计边界

- **L3 不直接访问文件系统或图像 API**：它只能做判断、调用受控 Skill 检索工具并输出计划。
- **L4 不决定用户意图**：它只按查询返回知识库候选项与依据。
- **L5 不自行换 Skill 或改写计划**：重试策略必须由 L2 保存的计划和 L3 的明确决策驱动。
- **L6 不是最后才补的安全层**：每个 API、工具调用和资产读取都要执行它的约束。

后文对应关系：第 7 节主要是 L4；第 8 节是 L3 与 L4；第 9、12、13 节是 L5；第 10 节是 L2 与 L6；第 11 节是 L1；第 14、15 节是 L6。

## 3. 技术选型

| 模块 | 推荐技术 |
| --- | --- |
| 应用 | Next.js 15、React 19、TypeScript |
| Agent 编排 | `@openai/agents` |
| OpenAI 客户端 | `openai` |
| 校验 | `zod` |
| 意图模型 | `gpt-5.6`（可由环境变量覆盖） |
| 图像编辑 | `gpt-image-2`；透明背景任务使用支持透明背景的 GPT Image 模型 |
| Skill 检索 | 复用现有 `retrieveSkills()` |
| 3D | `three`、`@react-three/fiber`、`@react-three/drei` |
| 任务状态 | 内存 Map + 临时文件 |
| 进度 | Server-Sent Events（SSE） |
| 团队访问 | 共享口令、昵称、签名 HttpOnly Cookie |

注意：根据 OpenAI SDK 类型定义，`gpt-image-2` 不支持 `background: "transparent"`。透明印花应使用支持透明背景的 GPT Image 模型，或将该能力作为首版限制明确展示。

参考：

- [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents/quickstart)
- [OpenAI 图片视觉输入](https://developers.openai.com/api/docs/guides/images-vision)
- [OpenAI 图像生成与编辑](https://developers.openai.com/api/docs/guides/image-generation)
- [GPT Image 2](https://developers.openai.com/api/docs/models/gpt-image-2)

## 4. 推荐目录结构

```text
app/
├── agent-studio.tsx
├── agent.css
├── components/mockup/
│   ├── ProductMockup.tsx
│   ├── MugScene.tsx
│   ├── TShirtScene.tsx
│   └── MockupControls.tsx
└── api/
    ├── auth/session/route.ts
    └── agent/
        ├── plan/route.ts
        └── runs/
            ├── route.ts
            └── [id]/
                ├── route.ts
                ├── events/route.ts
                ├── retry/route.ts
                └── assets/artwork/route.ts

src/lib/
├── agent/
│   ├── types.ts
│   ├── schemas.ts
│   ├── creative-agent.ts
│   ├── tools.ts
│   ├── generation-prompt.ts
│   ├── artwork-generation.ts
│   ├── run-store.ts
│   └── product-placement.ts
├── search-document.ts
└── retrieval-index-repair.ts

public/models/
├── mug.glb
└── tshirt.glb
```

## 5. 配置

```dotenv
OPENAI_API_KEY=
AGENT_MODEL=gpt-5.6
IMAGE_MODEL=gpt-image-2
TRANSPARENT_IMAGE_MODEL=gpt-image-1.5

TEAM_ACCESS_CODE=
TEAM_SESSION_SECRET=

AGENT_RUN_TTL_MS=3600000
AGENT_MAX_GLOBAL_RUNS=3
AGENT_MAX_IMAGE_BYTES=20971520
```

约束：

- API Key 只在服务端环境变量中读取，绝不返回浏览器。
- 生产环境缺少团队口令或 Session 密钥时禁用 Agent。
- 限制上传 PNG、JPEG、WebP，最大 20 MB，并按文件魔数而不是扩展名验证。

## 6. 数据模型

```ts
type AgentIntent = {
  sourceUsage: "preserve_subject" | "use_as_reference" | "extract_motif";
  deliverable: string;
  retrievalQuery: string;
  constraints: string[];
  backgroundMode: "transparent" | "opaque";
  explanation: string;
};

type SelectedSkill = {
  id: string;
  title: string;
  score: number;
  matchReason: string;
  libraryType: "photo" | "imported_skill";
};

type AgentPlan = {
  intent: AgentIntent;
  candidates: SelectedSkill[];
  selectedSkill: SelectedSkill;
  generationBrief: string;
};

type ProductPlacement = {
  offsetX: number;
  offsetY: number;
  scale: number;
  rotation: number;
};
```

任务状态：

```text
queued → analyzing_intent → retrieving_skill → generating_artwork → ready
                                                            └──→ failed
```

## 7. 知识库准备

### 7.1 统一搜索文档生成

抽取一个纯函数：

```ts
createSearchDocument(storedSkill): SearchCard
```

它负责生成 Skill/version identity、标题、分类、用途、标签、Retrieval Profile、Typography 检索文本、`searchText` 和审批状态。批准接口与索引修复必须调用同一函数，避免索引字段长期漂移。

### 7.2 检索就绪度

上线前报告：

- 已批准记录数。
- 活跃 Skill 数。
- 搜索文档数。
- 实际可检索 Skill 数。
- 缺少搜索文档的 Skill。
- 缺少或不兼容 Embedding 的 Skill。

目标：

```text
已批准且活跃的 Skill 数 = 可进入检索的 Skill 数
```

### 7.3 幂等索引修复

`repairRetrievalIndex({ dryRun })` 应：

- Dry Run 仅报告将修改的索引。
- 实际写入前备份旧文件。
- 只为已批准且活跃的版本补齐索引。
- 不修改配方、审批状态与版本关系。
- 重复执行不再产生变更。
- Embedding 不可用时保留关键词检索降级，不排除 Skill。

## 8. Agent 设计

### 8.1 唯一工具

Agent 仅能调用 `search_visual_skills`：

```ts
search_visual_skills({ query: string })
```

服务端固定返回 Top 3。结果只含必要 Skill 摘要：ID、标题、分数、命中原因、视觉定义、核心关系、复用公式、`mustRedesign` 与 `aestheticFloor`。

Agent 不拥有文件系统访问、任意网络工具或直接生图权限。

### 8.2 Agent 职责

1. 阅读用户 Prompt 与图片。
2. 判断图片用途。
3. 生成完整的 Skill 检索查询。
4. 调用本地检索工具。
5. 仅从本次 Top 3 中选择一个 Skill。
6. 判断透明印花或完整背景。
7. 输出结构化 `AgentPlan` 和生成 Brief。

### 8.3 图片用途

| 类型 | 使用场景 | 核心要求 |
| --- | --- | --- |
| `preserve_subject` | 人物、宠物、特定物体 | 保留身份、稳定外观、主体数量与核心结构 |
| `use_as_reference` | 氛围、场景、配色、灵感 | 用作内容或氛围参考，不锁定身份 |
| `extract_motif` | 徽章、符号、单体插画、印花 | 提取主体图形，优先透明背景 |

### 8.4 调试接口

先实现不生图的接口：

```text
POST /api/agent/plan
Content-Type: multipart/form-data

image=<image>
prompt=<text>
```

返回：

```json
{
  "intent": {},
  "candidates": [],
  "selectedSkill": {},
  "generationBrief": ""
}
```

验收：输出通过 Schema；选中 Skill 必属 Top 3；无可用 Skill 时停止而不产生生图费用。

## 9. 主图生成

生成提示词按以下优先级构造：

```text
用户原始要求
→ 图片用途与主体锁
→ 选中 Skill 的可迁移视觉规则
→ mustRedesign 与安全边界
→ 背景策略与输出规格
```

优先级：

```text
用户意图 > 主体保真 > Skill 视觉规则
```

Skill 可以控制构图、层级、色彩、材质、光线、字体、留白与视觉节奏；不得覆盖用户明确要求、人物身份、动物稳定特征、主体数量或商品结构。

禁止复制原图文字、Logo、签名、水印、受保护角色、精确原始版式和在世艺术家的独特风格。

提供三种重试：

| 策略 | 行为 |
| --- | --- |
| `same_plan` | 保留意图与 Skill，重新生成 |
| `next_skill` | 使用下一名候选 Skill |
| `replan` | 重新识别、检索并生成 |

## 10. 任务与 API

Run 存在进程内 Map 中，并将源图/结果图写入临时目录：

- 绑定 Session ID 与昵称。
- 默认一小时清理。
- 服务重启、刷新页面后不保证恢复。
- 单用户限制一个活动任务；全局限制并发。

API：

```text
POST /api/agent/runs
GET  /api/agent/runs/:id
GET  /api/agent/runs/:id/events
GET  /api/agent/runs/:id/assets/artwork
POST /api/agent/runs/:id/retry
```

SSE 事件：

```ts
type AgentRunEvent =
  | { type: "stage"; stage: AgentRunStage }
  | { type: "intent"; intent: AgentIntent }
  | { type: "retrieval"; candidates: SelectedSkill[] }
  | { type: "skill_selected"; skill: SelectedSkill }
  | { type: "generation_started" }
  | { type: "ready"; artworkUrl: string }
  | { type: "failed"; stage: AgentRunStage; code: string; message: string };
```

## 11. 前端工作台

新增 `创作 Agent / CREATE AGENT` 入口，保持现有编辑部式视觉。

页面分区：

1. 输入区：图片上传、拖放、Prompt、提交。
2. 进度区：意图识别、Skill 检索、主图生成、商品预览。
3. Agent 解释：图片用途、背景策略、Top 3、选中 Skill 和理由。
4. 结果区：主图下载与三种重试。
5. 3D 区：马克杯、T 恤、印刷区与导出。

页面逻辑放在 `app/agent-studio.tsx`，避免继续扩大 `app/page.tsx`。

## 12. 3D 商品预览

### 12.1 资产与许可

目标模型：

- [T Shirt by funlab117](https://sketchfab.com/3d-models/t-shirt-c1a3e5eb9b5445f4b7d4be82f1127eba)，CC BY。
- [Coffee Mug by blendernoob](https://sketchfab.com/3d-models/coffee-mug-0152ca330ae74089b5bac4f5d4be4f43)，CC BY。

在 `THIRD_PARTY_NOTICES.md` 中记录模型名称、作者、来源、许可证、改造内容及本地文件位置。

处理流程：删除无关相机/灯光，合并无用材质，确定可贴图 Mesh，减面与压缩，导出 Web 优化 GLB。推荐把两个模型总大小控制在约 10 MB。

### 12.2 实现顺序

1. 加载模型、相机、灯光、阴影、OrbitControls、错误提示。
2. 将主图作为纹理，静态显示在 T 恤胸前与杯子正面。
3. 增加真实印刷区约束。
4. 加入拖动、缩放、旋转、数值输入与重置。
5. 加入 PNG 与 JSON 导出。

### 12.3 印刷区规则

T 恤：只允许正面胸前矩形区域；禁止进入背面、袖子和领口。

马克杯：将水平位置映射为圆柱环绕角度，垂直位置映射为杯身高度；禁止图案进入杯沿、杯底和把手。

交互：拖动时关闭 OrbitControls，松开恢复；杯子和 T 恤各自保存 `ProductPlacement`，但共享同一张主图。

## 13. 导出

- 下载原始主结果 PNG。
- 商品画布以固定相机和光照导出 1600×1600 PNG。
- 同时导出布局 JSON。

```json
{
  "schemaVersion": "1.0",
  "product": "mug",
  "artworkRunId": "run_xxx",
  "placement": {
    "offsetX": 0.12,
    "offsetY": -0.04,
    "scale": 0.82,
    "rotation": 0
  }
}
```

首版不导出带贴图 GLB。

## 14. 团队访问与安全

登录：用户输入昵称与共享口令，服务端使用恒定时间比较口令，签发八小时有效的 HMAC 签名 HttpOnly Cookie。

安全要求：

- `HttpOnly`、`SameSite=Lax`，生产环境 `Secure`。
- 所有变更接口检查 Origin。
- Run、SSE 与资产接口验证任务归属 Session。
- 用户不可访问他人的临时任务。
- API Key 绝不进入前端。

## 15. 测试清单

### 单元测试

- AgentIntent、AgentPlan Schema。
- Agent 只能选择 Top 3。
- 主体锁优先于 Skill。
- 背景模式判断。
- 搜索文档生成与索引修复幂等性。
- 活跃版本门禁。
- T 恤矩形印刷区、马克杯圆柱坐标。
- Placement 边界限制。
- Cookie 篡改与过期。
- Session 隔离。

### API 集成测试

- 成功 Run、无可用 Skill、非法图片、超大图片。
- OpenAI 审核阻断、429、网络错误和 SSE 中断。
- 三种重试策略。
- 临时任务清理与越权访问。

### 人工验收

1. 人像身份、宠物稳定特征可保留。
2. 徽章/图形可以产生适合印花的输出。
3. 海报类任务保持完整背景与构图。
4. 杯子、T 恤可独立调整图案。
5. 图案不会进入杯把、T 恤背面或袖子。
6. 两个商品均可导出 PNG 与布局 JSON。
7. 现有测试继续通过，生产构建成功。

## 16. 开发里程碑

1. **Agent 规划**：类型、Schema、本地检索工具、`/api/agent/plan`。
2. **主图生成**：提示词构建、图像编辑、背景策略与下载。
3. **正式任务流**：Run Store、SSE、临时资产、重试、Agent Studio。
4. **3D 预览**：模型许可、模型加载、静态贴图。
5. **3D 编辑**：真实印刷区、拖动、缩放、旋转与重置。
6. **导出与访问**：PNG/JSON 导出、团队口令、Session 隔离、完整测试。

## 17. 首个最小闭环

首批代码只需要实现：

1. `src/lib/agent/types.ts`
2. `src/lib/agent/schemas.ts`
3. `src/lib/agent/tools.ts`
4. `src/lib/agent/creative-agent.ts`
5. `POST /api/agent/plan`

唯一目标：

```text
上传图片 + 输入 Prompt
→ AgentIntent
→ Top 3 Skill
→ Selected Skill
→ Generation Brief
```

这个闭环稳定后才接入图像生成；主图稳定后才进入 3D；最后才做登录、任务恢复和界面润色。
