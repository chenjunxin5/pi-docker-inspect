# 浏览器服务端

浏览器 UI 后面的 Node 进程。名字里带 server,但刻意做得很薄——所有推理都在 PI 那边。

## 职责

1. **实时 docker 数据** —— 列容器、拉日志 tail、实时 follow、新行流过来。
   用 `dockerode` 走 `/var/run/docker.sock` (或 `DOCKER_HOST`)。
2. **搜索** —— 内存缓冲区(follow 中)或临时 `docker logs` 快照(搜非活跃
   容器)上做 substring / regex。每行带上下文窗口。
3. **PI 桥接** —— 为每次提问创建独立的 in-process PI `AgentSession`
   (`src/pi-agent.js`);把浏览器的 "Ask LLM" 转发给 PI;把 SDK 的 `text_delta`
   流回成 `analysis_delta` 事件。
4. **心跳 + 可重连的 WS** —— 服务端 30s ping / 60s timeout;客户端指数退避重连。

明确**不是**的职责:

- ✗ 决定 LLM 应该看什么上下文
- ✗ 拼 prompt
- ✗ 调用 LLM
- ✗ 知道比 `src/docker.js` 包装更深的 docker 容器知识

## 文件布局

```
server.js              # 入口:HTTP + WS 服务,优雅关停
src/docker.js          # DockerClient: listRunning/fetchLogs/followLogs/getStats
src/search.js          # searchLines: substring (String.includes) + regex (带超时)
src/http-routes.js     # /api/health, /api/containers, /api/containers/:id/{logs,stats}
src/ws-router.js       # WS 消息分发 + 每连接状态
src/pi-agent.js        # PiAgent + PiAgentManager + 只读工具白名单
src/pi-docker-tools.js # 四个结构化 Docker 只读工具
public/                # 浏览器 SPA
```

## WS 协议

客户端 → 服务端:

| type | payload |
|---|---|
| `list_containers` | — |
| `fetch_logs` | `{ containerId, tail }` |
| `start_follow` | `{ containerId }` |
| `stop_follow` | `{ containerId }` |
| `search_logs` | `{ containerId, query, mode, contextBefore, contextAfter }` |
| `ask_llm` | `{ askId, containerId, containerName, matches?, userQuestion, analysisMode }` |
| `steer_ask` | `{ askId, message }`，当前工具完成后尽快加入本轮分析 |
| `follow_up_ask` | `{ askId, message }`，当前分析结束后自动追问 |
| `abort_ask` | `{ askId }` |

服务端 → 客户端:

| type | payload |
|---|---|
| `hello` | `{ ts }` |
| `containers` | `{ containers: [{id,name,image,state,status,ports}] }` |
| `logs` | `{ containerId, lines, tail }` |
| `follow_started` / `follow_stopped` | `{ containerId, reason?, ts? }` |
| `log_line` | `{ containerId, stream, text, ts }` |
| `search_results` | `{ containerId, matches, truncated, totalScanned }` |
| `analysis_started` | `{ askId, analysisMode }` |
| `analysis_meta` | `{ askId, hasThinkingSupport }` |
| `analysis_delta` | `{ askId, delta }` |
| `analysis_thinking_delta` | `{ askId, delta }` |
| `analysis_tool_call` | `{ askId, toolName, toolCallId, args, argsSummary }` |
| `analysis_tool_update` | `{ askId, toolName, toolCallId, partialResult }` |
| `analysis_tool_result` | `{ askId, toolName, toolCallId, isError, resultSize, durationMs }` |
| `analysis_message_end` | `{ askId, stopReason }` |
| `analysis_input_accepted` | `{ askId, mode, message }` |
| `analysis_input_error` | `{ askId, mode, message }` |
| `analysis_done` | `{ askId, fullText, partial? }` |
| `analysis_error` | `{ askId, message }` |
| `error` | `{ code, message }` |

## 每连接状态

```js
{
  selectedId: 'a9033b86…',         // 用于 follow-mode 缓冲
  followHandle: DockerStream | null,
  lineBuffer: [],                   // 最多 5000 行
  lineBufferCap: 5000,
  activeAsk: null,                  // { askId, client, text }
}
```

当新 `ask_llm` 来时,`activeAsk` 已经存在,前一个 ask 被 abort 顶替。
浏览器会看到:

```
analysis_done { askId: prev, partial: true, reason: 'superseded' }
analysis_started { askId: new }
```

这样反复点 "Ask LLM" 不会累积一堆未释放的 PI session。

分析进行中可以继续发送两种信息：

- `steer_ask` 调用 PI 原生 `steer()`：不会打断正在执行的工具，工具完成后会在
  下一次模型调用前加入信息；
- `follow_up_ask` 调用 PI 原生 `followUp()`：等当前 Agent 循环完成后，再自动
  开始处理补充问题。

两者都必须携带当前 `activeAsk.askId`。任务已经结束或编号不匹配时，服务端只返回
`analysis_input_error`，不会意外创建一个新会话。

## 项目代码映射 (`config/projects.json`)

把容器 → 源码仓库做成配置,PI 在分析这个容器报错时可以 `read` / `grep`
进仓库实际查代码,而不是凭空猜。

```json
{
  "ai_builder_celery": {
    "repo": "https://gitee.com/smilechenjx/ai-builder-agent.git",
    "branch": "main",
    "localPath": "~/projects/ai-builder-agent",
    "description": "Celery worker for ai-builder-agent (Python; minimal skeleton)"
  }
}
```

- 键 = 容器 **name**(不是 id,不是 image —— name 稳定且有意义)
- `branch` 必填,`localPath` 支持 `~` 展开
- 缺文件 / 不匹配 → 静默 no-op,prompt 不加 `[source-repo]` 段
- `scripts/setup-projects.sh` 自动 clone / fast-forward pull(脏工作树或
  non-ff 时跳过,**不 reset**)

被命中的容器在 ask prompt 里多一段:

```
[source-repo] /Users/SL/projects/ai-builder-agent — Celery worker for ai-builder-agent (Python)
```

PI 看到这段会知道去哪里翻代码。具体怎么翻(read 还是 grep)在
`skill/SKILL.md` 的工作流第 5 步教它。

`server.js` 启动 banner 多一行,方便确认 server 看到了哪些 mapping:

```
projects.json : .../config/projects.json  [2 mappings: ai_builder_celery, gen_image_redis]
```

完整设计见 [`docs/projects-mapping.md`](projects-mapping.md)。

## Ask 生命周期日志

每个 `ask_llm` 在服务端 stdout 上吐一条 `[pi]` 前缀的多行轨迹,对应
`pi --mode rpc` 子进程的事件:

```
[pi] 12:34:56.789 [ask-1740] ▶ prompt sent (1842 chars)
[pi] 12:34:59.901 [ask-1740] ◀ first delta after 3.11s
[pi] 12:35:00.123 [ask-1740] 🔧 docker_list_containers {}
[pi] 12:35:00.456 [ask-1740]   ✓ bash → 1234 bytes in 0.33s
[pi] 12:35:01.234 [ask-1740] 🔧 docker_search_logs {"container":"redis","query":"ERROR"}
[pi] 12:35:01.620 [ask-1740]   ✓ bash → 5678 bytes in 0.39s
[pi] 12:35:02.901 [ask-1740] ◀ done in 6.11s, 843 chars, stop=stop, 2 tool calls
```

每行:

- `▶ prompt sent` — `client.prompt()` 真正写到 stdin 时打,带 prompt 字节数。
- `◀ first delta after Xs` — 第一个 `text_delta` 到达时间,可用来观察冷启延迟。
- `🔧 <toolName> <args-truncated>` — PI 在调哪个工具 (bash / read / …),args
  被截到 `PI_LOG_ARGS_MAX` 字符 (默认 160)。
- `✓/✗ <toolName> → N bytes in Ts` — 工具完成,带 `isError` 标志。
- `◀ done/aborted in Ts, N chars, stop=X, K tool calls` — `agent_end` 时打,
  一行看明白整个 ask 的开销。

`askId` 直接复用浏览器生成的 ID (`'ask-' + Date.now() + '-' + random`),所以
控制台日志可以和浏览器 Network → WS 面板里 `analysis_*` 帧对得上。

工具调用与推理文本**默认**实时回传浏览器,折叠区组件即时显示。可视范围控制:

- 折叠区从 `analysis_started` 起自动展开,`analysis_done` 后折叠。
- 用户点开 `<details>` 后即使后续不再展开,内容仍在 (用 `_hasThinkingSupport` /
  `thinkingText.length` / `toolCalls[]` 这三个响应式字段控制)。

新增帧类型:

```
analysis_meta            { askId, hasThinkingSupport }
analysis_thinking_delta  { askId, delta }              // 流式
analysis_tool_call       { askId, toolName, toolCallId, args, argsSummary }
analysis_tool_update     { askId, toolName, toolCallId, partialResult }   // 部分工具流式输出
analysis_tool_result     { askId, toolName, toolCallId, isError, resultSize, durationMs }
```

> 旧版 `PI_BROWSER_TRACE=1` 开关已删除 —— 推理与工具细节一直是 PI 想要的信号,不应该藏起来。

## Follow-mode 背压

`docker.followLogs` 返回一个 Node stream。容器高频刷日志(几百行/秒)时,
无脑缓冲会 OOM。

缓解:
- 行缓冲上限 5000 行,新的来就 splice 老的
- 5 MB raw-buffer 高水位 → pause 源流
- 单行 > 64 KB 直接丢弃 + 警告 (例如太吵的 stack trace)

## REST API

`src/http-routes.js` 提供一个小 REST 用来偶尔 curl 一下:

```bash
curl localhost:3000/api/health
curl localhost:3000/api/containers | jq '.containers | length'
curl 'localhost:3000/api/containers/<id>/logs?tail=5'
curl 'localhost:3000/api/containers/<id>/stats'
```

其他都走 WS。REST 主要是给健康检查(`scripts/restart.sh` 轮询 `/api/health`
判断能不能 tail 日志)用的,不需要 WS。

## 优雅关停

收到 `SIGINT` / `SIGTERM`:

1. 关闭所有打开的 WS 连接(释放每连接状态、abort 任何活跃的 follow 流和 PI ask)
2. 停掉 WS 服务
3. 关掉 PI pool (杀掉所有 warm 子进程)
4. 关闭 HTTP 服务
5. 任何东西卡住,3s 后硬退出

这点很重要——即便 library 模式没有 PI 子进程,PI session 在被 `kill()` 之前
仍持有底层 LLM 连接;如果父进程崩溃没走 graceful shutdown,会泄露半开的连接。
`src/pi-agent.js` 的 `agentManager.shutdown()` 负责每个客户端的清理。

## 心跳

```js
// 每 30s:
for each ws:
  if (!ws.isAlive) terminate
  ws.isAlive = false
  ws.ping()

// 收到 pong:
ws.isAlive = true

// 60s 没 pong → terminate (下一次 30s tick 看到 isAlive=false)
```

浏览器不用关心——`ws.onclose` 一触发,客户端 store 走指数退避重连。

## 浏览器 SPA

前端**故意没构建**:

- Tailwind CSS 走 `https://cdn.tailwindcss.com/3.4.17`
- Alpine.js 走 `https://cdn.jsdelivr.net/npm/alpinejs@3.14.3`
- 不要 webpack/vite/TypeScript
- 一个 HTML (`public/index.html`) + 一个 JS (`public/app.js`)

这样表面积小(前端没有 `node_modules`),改 HTML/CSS/JS 刷新就行,没构建步骤。

### 踩过的 Alpine 反应式坑

最初用一个普通全局 JS 对象做 store。Alpine 不会代理普通 JS 对象,改了也不
触发重渲染。修法:在 `alpine:init` 监听器里通过 `Alpine.store('app', {...})`
注册。现在 `store.foo = bar` 是反应式的。

第二个坑:Alpine **会自动**对 `Alpine.store` 暴露的对象调 `init()`,而且对
每个 `x-data` 组件也调。所以一个 button click handler 调 `init()` 加上 Alpine
对 store 的自动 init 会导致双 WS 连接。修法:把入口改名为 `_start()`,用
`this._started` 守门。

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | `3000` | HTTP/WS 端口 |
| `DOCKER_HOST` | (未设) | dockerode 远程 (例如 `tcp://host:2375`) |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | dockerode unix socket |
| `PI_BIN` | _removed (library mode)_ | 已废弃——library 模式下不再需要 CLI 入口 |
| `PI_PROVIDER` | `minimax` | LLM provider |
| `PI_MODEL` | `MiniMax-M2.7` | 模型 id |
| `PI_SYSTEM_PROMPT` | (内置) | 覆盖默认的 SRE prompt |
| `PI_LOG_ARGS_MAX` | `160` | 工具调用 args 在控制台日志和浏览器 trace 折叠区里的截断长度 |
