# `server.js` 通俗讲解

> 前三篇分别讲了三个"零件"，这一篇讲**怎么把它们组装起来 + 让它们跑起来**。

---

## 一句话概括

**它是「整个应用的入口文件和总装车间」**：把前面所有的模块（`docker`、`pi-agent`、`http-routes`、`ws-router`、`projects`）像拼乐高一样拼到一起，加上心跳、优雅关闭、配置解析，最后监听一个端口跑起来。

---

## 它在整个项目里的位置

```
                         ┌──────────────────────────────────────┐
                         │             server.js                │
                         │   (入口 / 总装车间 / 生命周期管理)      │
                         └───────────────┬──────────────────────┘
                                         │
            ┌────────────────────────────┼────────────────────────────┐
            ▼                            ▼                            ▼
    ┌───────────────┐           ┌─────────────────┐          ┌────────────────┐
    │ docker.js     │           │ pi-agent.js     │          │ projects.js    │
    │ (调 Docker)    │           │ (PI library 适配器 + 安全守卫) │ │ (项目映射配置)   │
    └───────────────┘           └─────────────────┘          └────────────────┘
            ▲                            ▲                            ▲
            │                            │                            │
            └────────────────┬───────────┴────────────────────────────┘
                             │
                  ┌──────────┴──────────┐
                  ▼                     ▼
        ┌──────────────────┐   ┌──────────────────┐
        │ http-routes.js   │   │ ws-router.js      │
        │ (REST 4 个接口)   │   │ (WS 总接线台)      │
        └──────────────────┘   └──────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  public/ (静态页面)    │
                  └──────────────────────┘
```

可以把它想象成**餐厅的总店长**：

- 后厨有几组人（docker 班、AI 班、配置班）
- 餐厅有两条通道：堂食区（HTTP/REST）和包间长桌（WebSocket）
- 总店长负责**招人、安排座位、开门迎客、关门打烊**

---

## 为什么需要这一层？

按理说，前面四个文件已经能各自独立跑了，为什么还要一个 `server.js`？因为：

| 单个模块不能解决的事 | server.js 提供的 |
|------------------|-----------------|
| **到底起 HTTP 还是 WS？两个都要，怎么共存？** | `http.createServer(app)` + `new WebSocketServer({ server })` 一行接上 |
| **配置从哪来？端口多少？Docker socket 在哪？PI 用什么模型？** | 顶部那一堆 `process.env` 读取 |
| **进程挂了我怎么知道？** | 心跳 `setInterval` + `isAlive` 标记 |
| **Ctrl+C 时如何优雅退出？** | `SIGINT` / `SIGTERM` 监听 + `shutdown()` |
| **启动时打印哪些信息？配置对不对？** | `listen` 回调里的 banner |
| **404 兜底交给谁？** | `app.use(express.static(...))` 自动顶上去 |

**这是一个典型的「组合根（Composition Root）」**——所有依赖在这里被 new 出来、被串起来、被启停。业务模块（在 `src/`）都不需要关心"整个服务到底怎么起来"。

---

## 这一层干了哪些事？

按代码顺序走一遍。

### 1️⃣ 配置解析（顶部一堆常量）

```js
const PORT = parseInt(process.env.PORT, 10) || 3000;
const SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const PI_PROVIDER = process.env.PI_PROVIDER || 'minimax';
const PI_MODEL    = process.env.PI_MODEL    || 'MiniMax-M2.7';
const PI_SYSTEM_PROMPT = process.env.PI_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
```

这一段读起来很啰嗦，但**所有环境变量集中在这里、统一默认值**——是配置管理的最朴素做法：

| 变量 | 默认 | 作用 |
|------|------|------|
| `PORT` | 3000 | HTTP 端口 |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | Docker daemon 的 socket |
| `PI_PROVIDER` | `minimax` | LLM 提供方 (诊断用) |
| `PI_MODEL` | `MiniMax-M2.7` | 模型名 (诊断用) |
| `PI_SYSTEM_PROMPT` | 用文件内置默认值 | 注入给 PI 的系统提示 |

#### Library 模式：不再 spawn 子进程

跟早年的 RPC 模式不同，现在 PI 是**进程内的 npm 库**：`@earendil-works/pi-coding-agent`
通过 `createAgentSession()` 在当前 Node 进程里直接构造 `AgentSession`。`PI_PROVIDER` /
`PI_MODEL` 不再是命令行参数，而是诊断用的"我们当前配置的是什么 provider/model"，真正的
key / baseUrl 由 `ModelRuntime.create()` 自动从 `~/.pi/agent/{auth,models}.json` 读取。

### 2️⃣ 构造依赖（DI）

```js
const docker   = new DockerClient({ socketPath: SOCKET_PATH });
const agentManager = new PiAgentManager({ docker, systemPrompt: PI_SYSTEM_PROMPT });
const projects = loadProjects(__dirname);
```

这就是 **依赖注入（DI）的手动版**——手动 new 出三个核心对象，每个对象内部都已经封装好：

- `docker`：包装 Docker daemon 的 socket 客户端
- `agentManager`：为每次提问创建独立 `AgentSession` 的生命周期管理器（注册只读 Docker 工具和 tool-call 守卫）
- `projects`：容器名→项目仓库的映射（配置文件可能不存在，这里就是个无映射的对象）

**注意一个细节**：注释里写了 *"Auth + endpoint both come from PI's own config files: `~/.pi/agent/auth.json` / `~/.pi/agent/models.json`. We intentionally do NOT pass `--api-key` or `OPENAI_API_KEY` here."*

密钥不进环境变量、不进命令行参数——**完全交给 PI 自己从配置文件读**。这是个不错的安全习惯：

- 命令行 `ps` 看不到 key
- 进程环境列表看不到 key
- key 只存在用户 home 目录里、有正常的文件权限

### 3️⃣ 起 HTTP + WebSocket（最巧妙的一行）

```js
const app = express();
app.use('/api', createHttpRouter({ docker }));
app.use(express.static(path.join(__dirname, 'public')));

const http_srv = http.createServer(app);
const wss = new WebSocketServer({ server: http_srv, path: '/ws' });
attachWsRouter(wss, { docker, agentManager, projects });
```

这一段看似平淡，但**非常巧妙**：

| 步骤 | 干了什么 |
|------|---------|
| ① `app.use('/api', ...)` | REST 接口挂在 `/api/*` |
| ② `app.use(express.static(...))` | 剩下的都去 `public/` 找静态文件 |
| ③ `http.createServer(app)` | 把 Express 包成原生 HTTP server |
| ④ `new WebSocketServer({ server: http_srv, path: '/ws' })` | ⚡ **在同一个端口上开 WebSocket**，但只在 `/ws` 路径生效 |
| ⑤ `attachWsRouter(wss, {docker, agentManager, projects})` | 把前面三篇讲的接线台接进来 |

**关键点 ④**：WebSocket 协议通过 HTTP 的 `Upgrade` 头切换，所以**它可以挂在同一个 HTTP server 上、共用同一个端口**。结果是：

```
http://localhost:3000/             → 静态页面 (public/index.html)
http://localhost:3000/api/health   → http-routes.js 的健康检查
http://localhost:3000/api/containers
ws://localhost:3000/ws            → ws-router.js 的接线台
```

**一个端口，三种入口**——docker compose 部署、K8s service 暴露、运维都给"少开放一个端口"省了很多麻烦。

### 4️⃣ 心跳（WebSocket 必杀技）

```js
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) { /* ignore */ }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { /* ignore */ }
  }
}, 30_000);
heartbeat.unref?.();
```

WebSocket 长连接的一个老大难：**客户端挂了一半、TCP 连接看起来还活着**（比如 NAT 超时、笔记本休眠、网络切换）。如果服务端不知道，半死不活的连接会一直占着资源。

**经典 ping/pong 心跳**：

```
T=0s     ─── ws.ping() ───► 客户端（每 30s 一次）
                                 │
T=0~30s  ◄── ws.pong() ─────────┘   → ws.isAlive = true
T=30s    ─── ws.ping() ───►
       ...
       如果 60s（两次 ping 间隔）都没 pong → isAlive === false
       → ws.terminate() 强制掐掉
```

`heartbeat.unref?.()` —— `unref()` 让定时器**不阻止 Node 进程退出**。`?.()` 是为了兼容老 Node（没 `unref()` 也不报错）。

> 注意 `attachWsRouter` 那边也有一句 `ws.on('pong', () => { ws.isAlive = true; })`——**两边配合才完整**：这边"问"，那边"答"。

### 5️⃣ 启动 banner（贴心小提示）

```js
http_srv.listen(PORT, () => {
  console.log(`docker-logs-agent listening on http://localhost:${PORT}`);
  console.log(`  docker socket : ${SOCKET_PATH}`);
  console.log(`  pi mode       : library (in-process AgentSession)`);
  console.log(`  pi provider   : ${PI_PROVIDER}`);
  console.log(`  pi model      : ${PI_MODEL}`);
  // ... 探测 ~/.pi/agent/auth.json 和 ~/.pi/agent/models.json ...
  console.log(`  pi base url   : ${baseUrlHint}  (from ${modelsFile})`);
  console.log(`  pi auth.json  : ${authFile}  [${authHint}]`);
  // ... 如果配置不完整，发出 ⚠ 警告 ...
});
```

刚启动的时候打印**自检报告**：

```
docker-logs-agent listening on http://localhost:3000
  docker socket : /var/run/docker.sock
  pi mode       : library (in-process AgentSession)
  pi provider   : minimax
  pi model      : MiniMax-M2.7
  pi pool size  : 1
  pi base url   : https://api.minimax.io  (from /Users/x/.pi/agent/models.json)
  pi auth.json  : /Users/x/.pi/agent/auth.json  [present (minimax)]
  projects.json : /Users/x/.pi/projects.json  [2 mappings: api, worker]
```

而且**主动探测配置是否齐全**：

```js
const needsSetup = authHint !== `present (${PI_PROVIDER})` || baseUrlHint === 'missing'
  || baseUrlHint === `no '${PI_PROVIDER}' provider`;
if (needsSetup) {
  console.warn(`  ⚠ PI config incomplete for '${PI_PROVIDER}' — Ask LLM will fail.`);
  console.warn(`     run:  ./scripts/setup-pi-auth.sh`);
}
```

—— 比"启动失败、报错难懂"好太多：**上来就告诉你"哪里漏了配置、怎么补"**。

### 6️⃣ 优雅关闭：shutdown()

```js
function shutdown(reason) {
  console.log(`\n[shutdown] ${reason}`);
  clearInterval(heartbeat);
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server shutting down'); } catch (_) { /* ignore */ }
  }
  try { wss.close(); } catch (_) { /* ignore */ }
  agentManager.shutdown();
  http_srv.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

`Ctrl+C` 或 `docker stop` 时触发的关停流程：

```
SIGINT/SIGTERM
   │
   ▼
shutdown(reason)
   ├─► clearInterval(heartbeat)          // 停心跳
   ├─► ws.close() × 所有连接              // 告诉所有浏览器"我要关了"
   ├─► wss.close()                       // 关 WebSocket server
   ├─► agentManager.shutdown()           // 释放所有 PI session
   ├─► http_srv.close(() => process.exit(0))  // 关 HTTP server 后退出
   └─► setTimeout(3000, process.exit(1))  // 兜底：3s 内没退，强杀
```

**关顺序是设计过的**：

1. 先关 WS（触发 `ws.on('close')` → ws-router 里走"关页面收尾" → 中断 AI、释放 pool client）
2. 然后 `agentManager.shutdown()` 把所有 session `dispose()` 掉
3. 关 HTTP
4. 3 秒兜底强杀

注释里特别提醒了："**Close WS first so handlers release pool clients**"——这步不能错，否则 pool 里还挂着已死的连接，错乱。

#### 兜底异常

```js
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandled-rejection]', err);
});
```

- `uncaughtException` → 打印 + 优雅关闭（剩下的让 OS 决定要不要重启）
- `unhandledRejection` → 只打日志不退出（可能是某个请求的局部错误，不该全服务重启）

这两个 handler 不能让代码"看起来没事"——**异常发生了就要看得见**。

---

## 完整启动流程图

```
$ node server.js
      │
      ▼
[1] 解析所有 process.env
      │
      ▼
[2] new DockerClient() / new PiAgentManager() / loadProjects()
      │   ← agentManager 此时只初始化状态，不提前创建会话
      │
      ▼
[3] express() + 挂 /api + 挂 public/
      │
      ▼
[4] http.createServer + WebSocketServer({ server, path:'/ws' })
      │
      ▼
[5] attachWsRouter()  ← ws-router 接管 wss
      │
      ▼
[6] setInterval(heartbeat) 启动
      │
      ▼
[7] http_srv.listen(PORT, callback)
      │
      ▼
[8] callback 打印 banner + ⚠️ 配置自检
      │
      ▼
   ✦ 等待接入 ✦
       │
       │ SIGINT / SIGTERM
       ▼
   shutdown() 优雅收尾
```

---

## 整个项目的依赖关系全图

```
                          server.js
                              │
       ┌────────────┬─────────┼────────────┬────────────┐
       ▼            ▼         ▼            ▼            ▼
   docker.js   pi-agent.js  http-routes.js ws-router.js  projects.js
       │            │
       │            └─ defaults: PiAgent / PiAgentManager / DEFAULT_SYSTEM_PROMPT
       │                  + pi-docker-tools (createDockerTools)
       │
       └─ DockerClient（调 socket）
```

**`server.js` 是唯一一处"具体依赖各种环境、所有对象 new 在一起"的地方**。这意味着：

- 想换 WebSocket 库？换 `wss`，不用动其他文件
- 想加 GraphQL？新建一个 `graphql-routes.js`，挂上 `app.use(...)`
- 想换 PI 模型？改 `process.env`，不动代码

**所有这些灵活性，都靠"入口文件知道一切、业务文件一无所知"这个分层换来**。

---

## 总结一句话

> **`server.js` 是「组装车间 + 启动器 + 关停器」**：拼装、起服务、对外暴露三种入口（静态页面/REST/WS）、保持心跳、故障兜底——把一个"代码库"变成一个"运行中的服务"。

---

## 关键位置速查

| 关注点 | 位置 |
|--------|------|
| 配置 / 环境变量默认值 | 文件顶部 `const PORT = ...`、`const PI_PROVIDER = ...` 等 |
| Library 模式 | 没有 `PI_BIN`/`piCommand`，全部走进程内库调用 |
| 依赖实例化 | 中段的三个 `new` |
| HTTP + WS 同端口共存 | `new WebSocketServer({ server: http_srv, ... })` |
| 心跳 | `setInterval(heartbeat, 30_000)` 那一段 |
| 启动 banner + 配置自检 | `http_srv.listen(PORT, () => { ... console.log(...) })` |
| 优雅关闭 | `function shutdown(reason)` |
| 异常兜底 | 文件末尾两个 `process.on(...)` |

---

## 至此——4 篇文档的串联阅读顺序

1. **`pi-agent-explained.md`** → Node 怎么和 PI library 对接
2. **`ws-router-explained.md`** → 浏览器和 Node 之间怎么通信
3. **`http-routes-explained.md`** → 外部工具和 Node 之间怎么通信
4. **`server-js-explained.md`** ← 现在这里。所有零件怎么组装、怎么启停

按这个顺序读，**从底层到顶层**，整个项目就清晰了。
