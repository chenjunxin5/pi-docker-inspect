# `src/ws-router.js` 通俗讲解

> 这份文档解释「浏览器 ↔ 后端」之间的 WebSocket 通信是怎么搭起来的。

---

## 一句话概括

**它是「浏览器和 Node 服务之间的总接线台」**：浏览器发的每一条消息，它都知道该交给哪个内部模块去办；每个内部模块产出的结果，它也知道该用哪种 WS 消息推回浏览器。

---

## 它在整个项目里的位置

```
┌──────────────┐         WebSocket          ┌────────────────────────────────┐
│   浏览器 UI  │  ────────────────────────► │           ws-router.js         │
│  (前端)      │   JSON over single TCP     │  (本文件 — 路由 + 状态 + 拼装)  │
└──────────────┘  ◄──────────────────────── └────────┬───────────────┬───────┘
                                                    │               │
                                          ┌─────────▼─────┐ ┌───────▼────────┐
                                          │ docker 模块    │ │ pi-agent.js (池) │
                                          │ (抓日志/订阅)  │ │ (问 AI)        │
                                          └───────────────┘ └────────────────┘
```

如果昨天看的 `pi-agent.js` 解决的是"Node ↔ PI library"这一段，那 `ws-router.js` 解决的就是"**浏览器 ↔ Node 服务**"这一段，并且**把上面两个模块粘起来**。

---

## 为什么需要这一层？

WebSocket 和 HTTP 不同：一条长连接上可以塞**任意结构的消息**，看起来很自由，但坏处就是「乱」——没人管就成了一锅粥。这个文件就是来解决**乱**的问题：

| WebSocket 的坑 | 这个文件怎么补 |
|---------------|--------------|
| 没有"URL 路径"做分发 | 自己定一个 `type` 字段当路由键 |
| 长连接里状态会乱串 | 给每条连接一份**独立的 state** |
| 一边断了一边还在推 | `safeSend()` 检查 `readyState` 才发 |
| 一边推 JSON 一边崩 | 出错 catch 掉，不让一个连接挂掉整个服务 |
| 用户点了"切容器"忘了停流 | 自动 `stop()` 上一个 follow |
| 用户关页面了还有 AI 在跑 | `ws.on('close')` 收尾 |
| 同一连接连发两次 ask | 第二次自动 abort 掉第一次 |

---

## 这一层干了哪些事？

### 1️⃣ 入口函数：`attachWsRouter(wss, { docker, agentManager, projects })`

不"自己起"WebSocket server，而是**接管一个现成的 `wss`**。

```js
attachWsRouter(wss, { docker, agentManager, projects })
```

意思是：上层（`server.js`）已经用 `ws` 库创建了 server，但**怎么响应消息**由这个文件说了算。这是经典的「**控制反转**」：把"路由逻辑"从 server 启动代码中剥离。

它依赖三个外部能力：

| 字段 | 来自 | 作用 |
|------|------|------|
| `docker` | `src/docker.js` | 列容器、抓日志、订阅流 |
| `agentManager` | `src/pi-agent.js` | 创建一个 PI AgentSession、回流答案并负责释放 |
| `projects` | `src/projects.js` | 容器名 → 哪个项目/仓库的映射 |

> 这三个**不是直接 `require`，是从外部 inject 进来的**，方便测试时塞 mock。

### 2️⃣ 每条连接私有的 state（最关键的设计）

```js
const state = {
  selectedId: null,        // 当前正在看哪个容器
  followHandle: null,      // 实时订阅的句柄
  lineBuffer: [],          // 最近 N 行日志（最多 5000）
  lineBufferCap: 5000,
  activeAsk: null,         // { askId, client, text } 当前正在跑的 AI
};
```

**这一段是整个文件的核心。** 为什么？

WebSocket 是**长连接**——同一个浏览器，可能先后干这些事：

```
1. 列容器
2. 选了容器 A → start follow（流式）
3. 切到容器 B → 前面的 follow 要停掉、buffer 要清掉
4. 在 B 里搜索关键字
5. 把搜出的行选中 → 问 AI
6. AI 还在回答时，又切回 A，或再问一次
7. 关闭页面
```

如果**没有这份 per-connection state**，你猜会怎样？

- 切容器后还往浏览器推 A 的日志 → 错乱
- 同一个连接里两段 AI 答案混着推 → 错乱
- 关页后 server 还在推 → 资源泄露

所以 state 的目的就是「**把这个连接上发生的所有事，有序、不打架地串起来**」。

### 3️⃣ 路由表：浏览器发什么 → 后端做什么

```js
ws.on('message', (raw) => {
  const { type, payload } = JSON.parse(raw);
  switch (type) {
    case 'list_containers':   onListContainers();
    case 'fetch_logs':        onFetchLogs(payload);
    case 'start_follow':      onStartFollow(payload);
    case 'stop_follow':       onStopFollow(payload);
    case 'search_logs':       onSearchLogs(payload);
    case 'ask_llm':           onAskLlm(payload);
    case 'abort_ask':         onAbortAsk(payload);
  }
});
```

本质上就是一个**远程过程调用（RPC）表**。前端说的话：

| type | 后端干嘛 | 推回什么 |
|------|---------|---------|
| `list_containers` | 列运行中的容器 | `containers` |
| `fetch_logs` | 拉某容器的历史 N 行 | `logs` |
| `start_follow` | 订阅实时日志 | 一连串 `log_line` |
| `stop_follow` | 取消订阅 | `follow_stopped` |
| `search_logs` | 在本地 buffer 或新拉的尾部里搜关键字 | `search_results` |
| `ask_llm` | 把上下文扔给 AI（前面那个 pi-agent） | 一连串 `analysis_delta`，最后 `analysis_done` 或 `analysis_error` |
| `abort_ask` | 中断正在进行的 AI 回复 | （无，独立结果） |

### 4️⃣ 日志流（最复杂也最爽的一段）：`onStartFollow`

```js
const handle = docker.followLogs(containerId, {
  onLine: ({ stream, text, ts }) => {
    state.lineBuffer.push(`[${stream}] ${text}`);     // 1. 缓存
    if (state.lineBuffer.length > state.lineBufferCap)
      state.lineBuffer.splice(0, state.lineBuffer.length - state.lineBufferCap); // 2. 超过 5000 行就丢老的
    safeSend(ws, { type: 'log_line', payload: { containerId, stream, text, ts } }); // 3. 推给浏览器
  },
  onError: (err) => { ... },
  onEnd:   ()    => { ... },
});
state.followHandle = handle;
```

做的事就是**「Docker 一行一行吐 → 缓存进内存 + 实时推浏览器」**，这里有几个细节值得注意：

- **缓存的作用不只是回看**：搜索功能（`onSearchLogs`）**优先用这份缓存**搜，不要每次都去问 Docker（又慢又费 IO）。
- **超过 5000 行自动丢最老**——防止内存炸掉。
- **每次切容器都把 buffer 清空**：避免"上一个容器的日志"混入搜索。

### 5️⃣ 搜索：在缓存里翻关键字

```js
async function onSearchLogs({ containerId, query, mode, contextBefore, contextAfter }) {
  let lines;
  if (state.selectedId === containerId && state.lineBuffer.length > 0) {
    lines = state.lineBuffer;          // 已经在 subscribe：搜内存
  } else {
    lines = await docker.fetchLogs(containerId, { tail: 500 }); // 没 subscribe：临时拉一段
  }
  const stripped = lines.map((l) => stripStreamPrefix(l));   // 脱掉 [stdout] 前缀
  const result = searchLines(stripped, { query, mode, contextBefore, contextAfter });
  safeSend(ws, { type: 'search_results', payload: { ... } });
}
```

搜索结果就是用户后续 `ask_llm` 时 payload 里那份 `matches`——这也是**整个 AI 流程唯一的"上下文"**。

### 6️⃣ 核心中的核心：`onAskLlm`

这是把前面两个模块粘起来的地方：

```js
client = await agentManager.acquire();  // 1. 创建一个 PI AgentSession
// 2. 把用户问题 / 容器 / 选中的匹配行 拼成 prompt
const promptMessage = buildBrowserPrompt({...});
// 3. 调 client.prompt，发过去
client.prompt({ message: promptMessage }, {
  onDelta: (delta) => { /* 流式推给浏览器 */ },
  onMessageEnd: (msg) => { /* 一段话结束 */ },
}).then((result) => { /* done */ })
  .catch((err)   => { /* error */ });
```

注意几个细活：

#### ① 抢占：用户连发两次 ask

```js
if (state.activeAsk) {
  await prev.client.abort();           // 中断上一次
  agentManager.release(prev.client); // 释放旧会话
  state.activeAsk = null;
}
```

新问题总是会"顶掉"旧问题，并且告诉浏览器"上一次按 `partial: true` 收尾"。

#### ② 拼 prompt（`buildBrowserPrompt`）

不是简单把用户的问题塞给 AI，而是**精心拼装**：

```
[context] docker-logs UI is showing logs for: api (id: abc123)
[source-repo] /path/to/repo — 订单服务
[skill-name] docker-logs

[browser-highlighted-matches] (user-selected lines; you may also re-query with the read-only Docker tools)
  [L42] ERROR connection refused
  [L43] retrying in 5s
  ...

---
[user-question] 为什么这个容器一直重启？
```

把这段设计展开了讲：

- **`[context]`**：告诉 AI 当前在看哪个容器
- **`[source-repo]`**：如果这个容器对应某个项目代码仓库，顺手告诉 AI 它可以 `grep`/`cat` 源代码——**AI 自己会用工具读代码**，而不是只拿日志瞎猜
- **`[browser-highlighted-matches]`**：浏览器里高亮的那段日志（**这才是真正的"上下文"**）
- **`[user-question]`**：用户的问题

注意注释里写了："matches is now optional — PI's agent decides whether to use the browser-side selection as a hint or query the skill tools fresh." 也就是说：
**AI 是大脑，浏览器送来的 matches 只是「提示」，AI 有权自己拉新的日志**。这是个挺巧妙的设计 —— 你不用保证送给 AI 的就是完整上下文。

#### ③ 生命周期收尾

不论成功失败：

```js
client.removeListener('tool_start', onToolStart);   // 把监听拆掉
client.removeListener('tool_end', onToolEnd);       // 否则下一次借这个 client 会重复触发
safeSend(ws, { type: 'analysis_done', ... });
agentManager.release(client);                         // 释放会话
```

`acquire()` 每次都会创建全新会话，`release()` 负责释放，因此不会把上一次问的内容混进下一次。

#### ④ 实时 trace：默认开启

PI 内部事件无条件回传浏览器 —— `analysis_tool_call` / `_tool_update` /
`_tool_result` / `analysis_thinking_delta` 都直接 `safeSend` 不再走开关。折叠区
组件 (`public/index.html` 中 `<details>`) 自动展开 / 折叠,在答案 `<pre>` 上方
显示工具 timeline 与推理文本。控制台 `[pi] [ask-xxx]` 日志保持原有格式不变。

```
analysis_started
analysis_meta            { hasThinkingSupport: true }
analysis_tool_call       { toolName: 'bash', args: 'docker logs ...', argsSummary: '...' }
analysis_tool_update      { partialResult: '...' }   // 部分工具才发
analysis_tool_result     { ...bytes in 0.31s }
analysis_delta           "Looking at the last few lines..."
analysis_tool_call       { toolName: 'read', args: '/path/to/file.go', argsSummary: '...' }
analysis_delta           "The connection is using port..."
analysis_done            { fullText: '...', partial: false }
```

旧版 `PI_BROWSER_TRACE=1` 开关已删除 —— 推理与工具细节一直是 PI 想让运维看到的
信号,把它们默认藏起来并不划算。

### 7️⃣ 关页面 = 收尾

```js
ws.on('close', () => {
  state.followHandle?.stop();                     // 1. 停订阅
  if (state.activeAsk) {                          // 2. 停 AI
    a.client.abort().finally(() => agentManager.release(a.client));
  }
});
```

长连接断开时**主动清理**——这个细节是 WebSocket 应用最容易踩的坑。

### 8️⃣ console 日志助手：`makeAskLogger`

```js
[pi] 14:23:01.452 [a8b3] ▶ prompt sent (2410 chars)
[pi] 14:23:04.118 [a8b3] ◀ first delta after 2.67s
[pi] 14:23:04.220 [a8b3] 🔧 bash 'docker logs --tail=200 api'
[pi] 14:23:04.490 [a8b3]   ✓ bash → 18432 bytes in 0.27s
[pi] 14:23:08.733 [a8b3] ◀ done in 7.28s, 612 chars, stop=stop, 2 tool calls
```

这是一个**给运维看的小工具**：你在终端 `tail -f server.log` 时，能像看 git log 一样看到每一次 ask 的「开始 / 第一个字延迟 / 调了什么工具 / 调多久 / 总耗时」。对排查"为啥这次 ask 这么慢"超有用。

参数 `PI_LOG_ARGS_MAX` 控制工具参数打印多长（默认 160 字符），太长会被截断。

---

## 完整数据流图（一次 ask_llm 的全链路）

```
[浏览器]                                                       [后端]
   │                                                              │
   │ ── { type: "ask_llm",  ──►                                  │
   │      askId, containerId,                                     │
   │      matches, userQuestion }                                 ▼
   │                                              onAskLlm() 启动
   │                                                  │
   │                                                  ├─► agentManager.acquire()
   │                                                  │       (借 ai 子进程)
   │                                                  │
   │ ◄─── analysis_started { askId } ────────────────┤
   │                                                  │
   │                                                  ├─► buildBrowserPrompt()
   │                                                  ├─► client.prompt({...})
   │                                                  │
   │ ◄─── analysis_delta { delta: "Looking" } ───────┤
   │ ◄─── analysis_delta { delta: " at the" } ───────┤   （流式持续推）
   │ ◄─── analysis_thinking_delta { delta: '...' } ──┤  (模型在思考)
   │ ◄─── analysis_tool_call ... ───────────────────┤
   │ ◄─── analysis_tool_update (partialResult) ──────┤  (部分工具)
   │ ◄─── analysis_tool_result ... ──────────────────┤
   │ ◄─── analysis_delta { delta: " logs..." } ──────┤
   │              ... 持续几秒到几十秒 ...            │
   │                                                  │
   │ ◄─── analysis_message_end { stopReason } ───────┤
   │ ◄─── analysis_done { fullText, partial } ────────┤
   │                                                  │
   │                                                  └─► agentManager.release()
```

---

## 错误处理哲学

整个文件的错误处理风格非常一致：

1. **能 try/catch 的都包**（`onListContainers`, `onFetchLogs` ...）
2. **JSON.parse 包 try**，坏消息直接丢，不挂连接
3. **失败都用结构化 `{ type: 'error', payload: { code, message } }` 回前端**，而不是只给个字符串
4. **`safeSend` 检查 `readyState`** 再发，避免写关闭的 socket 抛错
5. **回调里再抛异常也不致命**，因为加了 `removeListener` + 外层包好

这套约定让上层 `server.js` 几乎不用关心"消息会不会让连接崩"。

---

## 总结一句话

> **`ws-router.js` 是一个长连接状态机 + 协议路由表 + 两个外部模块的胶水层**：它让浏览器和后端像"互相调用函数"一样方便，并且每个浏览器会话都有独立、干净、可清理的上下文。

把它抽出来后：

| 不抽的后果 | 抽出的好处 |
|----------|----------|
| `server.js` 七八百行混杂路由 | 启动代码 ↔ 业务路由物理分离 |
| 多个连接互相串状态 | 每连接独立 state，互不干扰 |
| AI 调用和日志流混在一起 | 日志流 / AI 流在同一个文件里**有序协作**，互不打架 |
| 一个 bad message 可以让 wss 整片挂 | 每条消息都在 try 里，错误被结构化回吐 |
| 难以单元测试 | 三个依赖全部 inject 进来，单测里塞 mock 就行 |

---

## 关键位置速查

| 关注点 | 位置 |
|--------|------|
| 每条连接的 state | `wss.on('connection', ws => { const state = {...} })` |
| 消息路由分发 | `ws.on('message', ...)` 里那个 `switch (type)` |
| 日志流推送 | `onStartFollow` 里的 `docker.followLogs(...)` |
| 搜索逻辑 | `onSearchLogs` |
| **AI 流程**（重点） | `onAskLlm` |
| 拼 prompt 模板 | `buildBrowserPrompt()` |
| 关连接清理 | `ws.on('close', ...)` |
| 安全发送 | `safeSend(ws, obj)` |
| 运维日志样式 | `makeAskLogger(askId)` |
