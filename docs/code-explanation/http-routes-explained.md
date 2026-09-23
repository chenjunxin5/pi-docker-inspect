# `src/http-routes.js` 通俗讲解

> 一份配套文档：上一篇讲 WebSocket（流式、推送、长连接），这一篇讲 **REST API**（一次性、请求-响应、零状态）。

---

## 一句话概括

**它是「面向外部/管理端的极简 REST 接口」**：浏览器主要走 WebSocket，但有些场景（健康检查、脚本、CI）更适合用 HTTP——这个文件就是为这些场景准备的。

---

## 它在整个项目里的位置

```
                            ┌───────────────────────────────┐
                            │       docker-logs-agent        │
                            │                                  │
浏览器主交互 (流式 / 状态) ──┤   ws-router.js   ← 主要 UI 流    │
                            │                                  │
外部一次性 / 健康检查 ──────┤   http-routes.js ← 这里          │
                            │                                  │
AI session 对接 ─────────────┤   pi-agent.js                     │
                            │                                  │
                            └───────────────────────────────┘
```

如果项目里所有的"问后端"都走 WebSocket，那就不需要这份文件。但现实里，**有一些场景天生就适合 HTTP**：

| 场景 | 为什么用 HTTP 更合适 |
|------|-------------------|
| K8s liveness/readiness probe | 探针不持连接，HTTP `curl /health` 就行 |
| CI 脚本里读一次日志 | 临时拿一段日志，不需要长连接 |
| 监控系统拉指标 | `stats` 接口用轮询最简单 |
| 运维 / 调试（终端 curl） | `curl localhost:3000/api/containers` 一行搞定 |

所以这个文件提供的就是这套"**辅助 HTTP 接口**"——**不是主菜，是配菜**。

---

## 为什么需要这一层？

### ① 没有这一层会怎样？

假设你在 K8s 里部署这个服务，探针配置：

```yaml
livenessProbe:
  httpGet:
    path: /api/health
    port: 3000
```

如果只有 WebSocket，你只能让探针 ping 一个根本不存在的 HTTP server——服务**明明活着**，K8s 也只能告诉你"unhealthy"，最后被无情重启。

### ② 为什么不用 `ws-router` 顺便做这件事？

| 维度 | WebSocket | HTTP |
|------|----------|------|
| 协议 | 一次握手后双向 | 请求-响应，状态机简单 |
| 客户端 | 必须是个 WS 客户端 | `curl` / `wget` / 任何 HTTP 库都行 |
| 探测友好 | ❌ 探针不持连接 | ✅ 一发一收，自动结束 |
| 适合的场景 | 推送、流式、长时间状态 | 健康检查、单次查询、轮询 |

**所以功能上可以全塞 WebSocket，但是从「被使用」的角度，HTTP 接口能给运维和工具链极大的便利**——这一层就是为它们准备的。

---

## 这一层干了哪些事？

整个文件**只有 4 个 endpoint，加 2 个工具函数**，但非常干净。

### 1️⃣ 入口函数：`createHttpRouter({ docker })`

```js
const router = createHttpRouter({ docker });
app.use('/api', router);
```

跟 `attachWsRouter` 一样，**也是工厂模式 + 依赖注入**：

- **工厂**（不是直接 `module.exports = router`）：保证每次调用都返回**新的 router 实例**，避免测试之间的状态污染
- **注入 `docker`**：方便单测时塞 mock（虽然这个文件没有显式测试，结构上仍然是好实践）

> 注意：`docker` 没有像 `ws-router` 那样还要 `piPool` / `projects`，因为 HTTP 接口**只读容器和日志，不问 AI**。它和 AI 流程不沾边。

### 2️⃣ 4 个 endpoint 详解

#### `GET /api/health` —— 心跳

```js
router.get('/health', (_req, res) => {
  res.json({ ok: true, version: '0.1.0', ts: Date.now() });
});
```

**作用**：告诉别人"我活着"。

返回：
```json
{ "ok": true, "version": "0.1.0", "ts": 1758432000000 }
```

| 字段 | 干什么 |
|------|-------|
| `ok` | 健康标志，K8s 探针 / 监控系统认这个 |
| `version` | 当前服务的版本号（写死 0.1.0） |
| `ts` | 服务器时间戳，给调试用 |

**这是个"无依赖"接口**——它**不调 docker**，所以哪怕 Docker 挂了，health 也能返回 `ok: true`。

> 这点很重要：监控的"自我存活"和"业务能不能跑"是**两件事**，分开报才是对的。

#### `GET /api/containers` —— 列运行中的容器

```js
const containers = await docker.listRunning();
res.json({ containers });
```

返回：
```json
{
  "containers": [
    { "id": "abc123", "name": "api", "image": "my-api:1.2", ... },
    ...
  ]
}
```

**和 WS 的 `list_containers` 是一模一样的功能**——只不过这里走 HTTP、只拿一次、不订阅。

适用场景：
- 监控大盘轮询
- 部署后 sanity check：新的容器起来了吗
- CI 里"对比期望的容器集合"

#### `GET /api/containers/:id/logs?tail=500` —— 一次性拉一段日志

```js
const tail = clamp(parseInt(req.query.tail, 10) || 500, 1, 100_000);
const lines = await docker.fetchLogs(id, { tail });
res.json({ containerId: id, tail, lines });
```

入参：
- 路径参数 `:id` —— 容器 ID
- 查询参数 `tail` —— 拉几行（默认 500）

返回：
```json
{
  "containerId": "abc123",
  "tail": 500,
  "lines": ["[stdout] Started server on :8080", "[stderr] WARN ...", ...]
}
```

**这跟你 `docker logs --tail=500 <id>` 干的事一样**，只不过走 HTTP。

注意那行 `clamp(..., 1, 100_000)`——**保护机制**：哪怕有人传 `tail=999999999` 也只给你 10 万行，避免 OOM。

#### `GET /api/containers/:id/stats` —— 容器资源使用情况

```js
const stats = await docker.getStats(req.params.id);
res.json({ containerId: req.params.id, stats });
```

`stats` 一般是 CPU%、内存占用、网络收发字节等。
**这个接口 WS 那边没提供**——因为监控一般轮询，没必要长连接。

### 3️⃣ 错误处理：`toApiError`

```js
function toApiError(err) {
  const msg = err && err.message ? err.message : String(err);
  const status = err && err.statusCode ? err.statusCode
    : /ENOENT|EACCES|ECONNREFUSED/.test(msg) ? 503
    : 500;
  return { code: err?.code || 'INTERNAL', message: msg, status };
}
```

把"各种各样的内部错误"**统一成"HTTP 风格的 API 错误"**：

| 内部异常 | HTTP 状态 | 含义 |
|---------|---------|------|
| Docker API 自带 `statusCode` | 用它原值 | 比如 `dockerode` 报的 404 |
| 错误信息含 `ENOENT` / `EACCES` / `ECONNREFUSED` | 503 | Service Unavailable（Docker 不通 / 文件找不到 / 权限拒绝） |
| 其他 | 500 | Internal Server Error |

返回的格式：
```json
{
  "error": {
    "code": "ENOENT",
    "message": "no such file or directory",
    "status": 503
  }
}
```

**为什么用 `503` 而不是 `404`？** 因为这些错误基本都意味着"Docker daemon 现在调不到"——**503（服务暂时不可用）**比 404 更准确。客户端看到 503 就知道："等会再试或者切备用"。

### 4️⃣ 数字夹紧：`clamp`

```js
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
```

跟 `ws-router.js` 里那个 `clamp` **一模一样**——典型的"工具函数被多次用到"。
（小细节：两个文件各定义了一份，而不是抽公共 utils，可能是因为这种小函数不值得为它单独开文件。但也是可以考虑改进的地方。）

---

## 完整请求-响应示例

```bash
$ curl http://localhost:3000/api/health
{"ok":true,"version":"0.1.0","ts":1758432000000}

$ curl http://localhost:3000/api/containers
{"containers":[{"id":"a1","name":"api","image":"my-api:1.2",...}]}

$ curl 'http://localhost:3000/api/containers/a1/logs?tail=5'
{"containerId":"a1","tail":5,"lines":["...","...","..."]}

$ curl http://localhost:3000/api/containers/a1/stats
{"containerId":"a1","stats":{"cpu":12.3,"mem":234567890,...}}
```

---

## 和 `ws-router.js` 的对比

| 维度 | `ws-router.js` | `http-routes.js` |
|------|---------------|------------------|
| 通信方式 | WebSocket（长连接） | HTTP（请求-响应） |
| 状态 | 每连接一份 `state` | **完全无状态** |
| 主要客户 | 浏览器 UI | 探针、CI、监控、运维 |
| 涉及 AI？ | 是（`onAskLlm`） | 否 |
| 涉及 Docker 日志流？ | 是（`onStartFollow`） | 否（只 snapshot） |
| 错误处理 | 结构化 JSON 回吐 | 标准 HTTP status code |
| 单测友好度 | 中（需要 mock ws） | 高（标准 `supertest` 模式） |

**它们是互补的，不是替代的**。可以理解为：

```
浏览器日常 ═══ WebSocket ═══ ws-router ═══ [AI + Docker]
K8s/CI/脚本 ─ HTTP ─────── http-routes ─── [Docker 读]
```

---

## 总结一句话

> **它就是给"非浏览器、非长连接"的场景准备的 4 个 REST endpoint：探针、列容器、拉日志、拉统计——简单、无状态、独立、可靠。**

把这个文件抽出来的好处：

| 不抽的后果 | 抽出的好处 |
|----------|-----------|
| 想加健康检查就得在 ws-router 里专门开 case | 各管各的，关注点分离 |
| CI 脚本被迫用 WS 客户端 | 直接 `curl` 就行 |
| K8s 探针要重新写 | `app.use('/api/health', ...)` 一行接进来 |
| 监控轮询吃 WebSocket 连接池 | 一次性 HTTP 连接，不占 slot |

---

## 关键位置速查

| 关注点 | 位置 |
|--------|------|
| 工厂入口 / 依赖注入 | `createHttpRouter({ docker })` |
| 健康检查 | `router.get('/health', ...)` |
| 列表 / 日志 / 统计 | 后面三个 `router.get(...)` 块 |
| 错误归一化 | `toApiError(err)` |
| 数字夹紧防 OOM | `clamp(n, lo, hi)` |
