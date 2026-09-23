# 架构

PI 原生设计：浏览器是薄薄的 viewer，PI 通过内嵌的 `docker-logs` skill
编排所有日志分析。

## TL;DR

```
┌──────────────────────────────────────────────────────────────────┐
│                       浏览器 (SPA)                                │
│  Alpine + Tailwind · 实时容器列表 · follow · 搜索                │
│  - 所有日志 IO 走服务端 WS,不经过 PI                               │
│  - "Ask LLM" 只发用户问题 + 一小段 hint                           │
└─────────────────────┬────────────────────────────────────────────┘
                      │ WebSocket 帧 (JSON, 双向)
┌─────────────────────▼────────────────────────────────────────────┐
│                       server.js (Node)                           │
│  - Express + ws + dockerode                                       │
│  - 每个连接独立状态: { selectedId, followHandle, activeAsk }      │
│  - 为每次提问创建独立的 in-process AgentSession (`src/pi-agent.js`) │
│  - Ask LLM 通过 library API 事件转发（流程见下）                  │
└─────────────────────┬────────────────────────────────────────────┘
                      │ in-process (no IPC; same Node process)
┌─────────────────────▼────────────────────────────────────────────┐
│            PI AgentSession (library API, in-process)             │
│                                                                  │
│  自动加载的 skill (从 ~/.pi/agent/skills/ 发现):                   │
│  ├── docker-logs  (本项目)                                       │
│  └── …                                                            │
│                                                                  │
│  Agent loop:                                                     │
│  1. 收到 prompt                                                  │
│  2. 决定哪些 skill 适用                                          │
│  3. 调用结构化的只读 Docker 工具                                 │
│  4. 基于工具结果推理                                             │
│  5. 流式 text_delta → WS 的 analysis_delta                        │
│  6. agent_end → WS 的 analysis_done                              │
└─────────────────────┬────────────────────────────────────────────┘
                      │ in-process tool call
┌─────────────────────▼────────────────────────────────────────────┐
│       skill + custom tools (本项目)                               │
│  - SKILL.md 教 PI 何时加载以及推荐的排障流程                      │
│  - pi-docker-tools.js 定义严格参数和只读操作                      │
│  - DockerClient 直接访问 Docker API，不经过 shell                 │
│  - 工具白名单不开放 bash/edit/write                               │
└──────────────────────────────────────────────────────────────────┘
```

关键不变量：**PI 的 agent loop 拥有所有"问模型"的推理**。
浏览器服务端从不预拼完整分析上下文，只转发用户问题。PI 按需调用只读 Docker 工具。

## 为什么这么设计

### 三层分离

| 层 | 职责 | 实现 |
|---|---|---|
| **视图 (View)** | 渲染实时数据,接收用户意图 | 浏览器 (Alpine + Tailwind,无构建) |
| **桥接 (Bridge)** | 流式传容器数据 + 中转问题 | `server.js` (Express + ws + dockerode) |
| **大脑 (Brain)** | 推理日志、调用工具、流式输出分析 | `@earendil-works/pi-coding-agent` library,加载 `docker-logs` skill |

最初的设计把桥接 + 大脑压在一起。结果是手工拼装的 prompt template 必须提前知道抽什么上下文、怎么格式化。任何没提前抽出来的内容 LLM 都看不到,后续追问也支持不了,只能让用户重新问。

PI 原生设计把推理移进 agent loop。PI 可以:
- 当浏览器预选的命中够用时,信任它
- 不够(或过时)时,重新拉新上下文
- 链式调用工具 (search → 读更多上下文 → stats → 回答)
- 在同一 session 里处理追问

### 为什么同时使用 Skill 和自定义工具

Skill 负责渐进式披露排障流程，自定义工具负责安全执行。两者组合后：

1. **职责清晰。** Skill 是说明书，工具是受约束的执行接口。
2. **结构化参数。** 容器、搜索模式、日志行数和上下文数量都经过 JSON Schema 校验。
3. **避免 shell。** Docker 查询直接复用 `DockerClient`，没有命令拼接和转义问题。
4. **权限可验证。** `tools` 白名单仅包含 `read/grep/find/ls` 和四个 Docker 工具。

### 为什么保留独立的浏览器服务端

| 场景 | 浏览器 UI | 纯 PI TUI |
|---|---|---|
| 50 行/秒 follow + 自动滚动 | 简单 | 难 (无滚动、无 widget) |
| 切换 regex / substring 搜索 | 简单 | 不支持 |
| 点某一行再提问 | 简单 | 不支持 |
| 多栏布局 (日志 | 提问面板) | 简单 | 不支持 |
| 从任意地方提问、无 UI | 不支持 | 简单 |

用户明确要**基于浏览器的工具**。所以单纯 PI TUI 不行。但浏览器不必是"大脑"——它只需要把用户意图转给 PI。

## 文件布局

```
docker-logs-agent/
├── package.json          # node 依赖 + pi-package 清单 (pi.skills)
├── server.js             # Express + ws + 优雅关停
├── src/                  # node 代码:仅浏览器侧
│   ├── docker.js         # dockerode 封装 (listRunning/fetchLogs/followLogs)
│   ├── search.js         # substring / regex,带超时
│   ├── http-routes.js    # /api/health, /api/containers, /api/containers/:id/{logs,stats}
│   ├── ws-router.js      # WS 消息分发 + 每连接状态
│   ├── pi-agent.js       # PI library 适配器 + 只读工具白名单
│   └── pi-docker-tools.js # 结构化 Docker 只读工具
├── public/               # 浏览器 SPA
│   ├── index.html
│   └── app.js
├── skill/                # PI skill (也可作为 pi-package 安装)
│   └── SKILL.md          # 指令
├── scripts/              # 项目本地辅助
│   ├── setup-pi-auth.sh
│   ├── restart.sh
│   ├── browser-smoke.js  # Playwright E2E
│   ├── ws-smoke.js       # WS 协议测试
│   └── ws-follow.js      # follow-mode 测试
└── docs/                 # 本目录
```

`src/pi-agent.js` 和 `src/docker.js` 是最微妙的两块。前者创建 PI 会话并把少量 SDK
事件交给回调；后者在原始日志 buffer 上 demux docker 的 8 字节流帧头。详见
[`docs/pi-agent-explained.md`](../code-explanation/pi-agent-explained.md)。

## "Ask LLM" 的完整流程

### 浏览器 → 服务端

```json
{
  "type": "ask_llm",
  "payload": {
    "askId": "ask-12345-abc",
    "containerId": "a9033b86...",
    "containerName": "gen-image-redis",
    "matches": [{"lineNo": 9, "text": "Background saving started", "before": [...], "after": [...]}],
    "userQuestion": "Is this redis healthy?"
  }
}
```

### 服务端 → PI (library API `session.prompt()`)

服务端拼一个最小的 hint payload,不是预拼的分析 prompt:

```json
{
  "id": "r1-xyz",
  "type": "prompt",
  "message": "[context] docker-logs UI is showing logs for: gen-image-redis\n[skill-name] docker-logs\n\n[browser-highlighted-matches] (user-selected lines; you may also re-query with Docker tools)\n  [L9] Background saving started by pid 35\n\n---\n\n[user-question] Is this redis healthy?"
}
```

这个 hint 是故意做小的:
- `[context]` 告诉 PI 用户当前在看哪个容器 (好让它作用域调用 skill)
- `[skill-name]` 提醒 PI skill 名字,即使它没 `read` SKILL.md
- `[browser-highlighted-matches]` 作为提示,但 PI 也可以重新拉

### PI 的 agent loop

```
1. agent_start
2. text_delta: "<think>用户问 redis 健康度…</think>"
3. toolcall_start: docker_list_containers
4. tool_execution_start: docker_list_containers
5. tool_execution_end: { result: { content: [{ text: "{...redis containers...}" }] } }
8. (PI 可能继续发工具调用,直到信息够了)
9. text_delta: "## ✅ gen-image-redis is Healthy\n\n…"
10. text_end
11. agent_end
```

### 服务端 → 浏览器 (事件映射)

| PI 事件 | 浏览器 WS 消息 |
|---|---|
| `message_update { text_delta }` | `analysis_delta { askId, delta }` |
| `message_end` | `analysis_message_end { askId, stopReason }` |
| `agent_end` (成功) | `analysis_done { askId, fullText }` |
| `agent_end { willRetry:true }` | (无——浏览器一直转圈) |
| `agent_end { stopReason:'error' }` | `analysis_error { askId, message }` |
| `agent_end { stopReason:'aborted' }` | `analysis_done { askId, partial:true }` |

浏览器目前还收不到 `tool_execution_*` 事件的上报——未来增强可以把
"🔧 docker_search_logs" 显示在分析面板里。

## 协议:Library API 事件流

`@earendil-works/pi-coding-agent` 是 ESM 库,通过 `createAgentSession()` 在当前 Node 进程里
构造一个 `AgentSession`。服务端调用 `session.prompt()`，并通过
`session.subscribe()` 接收流式事件；`src/pi-agent.js` 只把页面需要的事件交给
`src/ws-router.js` 提供的回调。

适配层 (`src/pi-agent.js`) 维护:
- **事件路由**:单个 `session.subscribe()` 监听器处理 `message_update`、
  `message_end`、`tool_execution_start`、`tool_execution_end` 和 `agent_end`，
  再调用对应的页面回调。
- **Tool-call 守卫**:通过 `DefaultResourceLoader({ extensionFactories })`
  注入扩展,扩展注册 `pi.on('tool_call', ...)` 钩子,命中 denylist 时返回
  `{ block: true, reason, terminate: true }`。详见
  [`docs/pi-agent-explained.md`](../code-explanation/pi-agent-explained.md)。
- **Promise**:`prompt()` 直接等待 PI 原生 Promise，由 PI 自己处理工具循环和重试。
- **生命周期**:每次提问创建独立会话；`release()` 调用 `session.dispose()` 并清理监听。

## Skill 格式

Skill 是带 `SKILL.md` frontmatter 的目录:

```yaml
---
name: docker-logs
description: Inspect and analyze Docker container logs on the local machine. Use when the user asks about a running container's status, errors, recent output, resource consumption, or wants to debug a container.
---
```

`description` 是 PI 决定是否加载 skill 的依据 (progressive disclosure——
只有 description 一直在上下文里;body 按需加载)。写具体、塞满触发词,别让 PI
错过匹配。

`SKILL.md` body:
- **何时加载 / 不加载** —— 显式的触发器和排除项
- **工具参考** —— 四个 Docker 工具各自适用的场景
- **工作流提示** —— 推荐的调用顺序、引用证据的规范

工具定义位于 `src/pi-docker-tools.js`，通过 `customTools` 注册。

## 分发

这个包是合法的 [pi-package](https://pi.dev/docs/packages):

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./skill"]
  }
}
```

用户可以这样安装:

```bash
npm publish                  # 然后:
pi install npm:docker-logs-agent

# 或者从 git 检出:
pi install /path/to/docker-logs-agent

# 只要 skill(不要 browser server):
pi install ./skill
```

PI 安装时把 `skill/` 拷到 `~/.pi/agent/skills/docker-logs/`,后续任何 session
(TUI 或 library API) 自动加载。

开发期用 symlink 而非 copy,这样 `skill/` 改了立刻生效:

```bash
npm run skill:link    # ln -sfn $PWD/skill ~/.pi/agent/skills/docker-logs
npm run skill:unlink  # rm ~/.pi/agent/skills/docker-logs
```

## 未来增强

| 想法 | 备注 |
|---|---|
| Token 流式取消 | 现在断开就 abort;PI 的 `abort` 等 `agent_end`。可以把 `auto_retry_*` 透出到浏览器作 "2s 后重试…" |
| 多容器分析 | PI 现在就能做;浏览器加个 "多选" 模式 |
| 改用 Extension | 如果加自定义工具 UI (比如交互式容器选择器、命令自动补全),改 TS extension + `registerTool` + `pi.sendMessage` |

> "PI 工具调用透传给浏览器" 已在 `analysis_tool_call / _tool_update / _tool_result /
> analysis_thinking_delta` 落地 (默认开启,折叠区组件实时显示);持久化 session 由
> `src/investigation.js` 处理。
