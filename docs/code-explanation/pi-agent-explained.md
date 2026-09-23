# `src/pi-agent.js` 学习指南

## 一句话概括

`pi-agent.js` 是项目与 PI 框架之间的一层薄适配：创建只读会话、安装安全守卫、
注册 Docker 自定义工具、转发页面需要的事件，并在使用结束后释放会话。

PI 框架已经负责 Agent 循环、模型调用、工具执行、自动重试和中止处理，项目不再重复实现这些能力。

## 完整调用流程

```text
浏览器提问
    │
    ▼
ws-router.js
    │ acquire()
    ▼
PiAgentManager ── 创建一个新的 PiAgent
    │
    ▼
PiAgent.start()
    │
    ├─ 创建 DefaultResourceLoader
    ├─ 注册工具安全守卫
    ├─ 注册只读 Docker 工具和工具白名单
    ├─ 创建 AgentSession
    └─ 订阅 PI 事件
    │
    ▼
PiAgent.prompt()
    │
    ├─ text_delta           → 页面显示流式文本
    ├─ tool_execution_start → 记录工具开始
    ├─ tool_execution_end   → 记录工具结果
    └─ agent_end            → 记录本轮汇总
    │
    ▼
PiAgentManager.release() ── 释放会话
```

## 为什么使用动态导入

项目使用 CommonJS，PI 库使用 ESM，因此不能直接 `require()`：

```js
const piLibPromise = import('@earendil-works/pi-coding-agent');
```

动态导入只执行一次。`ModelRuntime` 也只创建一次，由所有临时会话共用：

```js
const modelRuntimePromise = piLibPromise.then((lib) => lib.ModelRuntime.create());
```

## 如何创建会话

`createSession()` 是接入 PI 的核心：

1. 创建 `DefaultResourceLoader`，加载提示词、技能和扩展。
2. 调用 `resourceLoader.reload()` 完成资源发现。
3. 调用 `createAgentSession()` 创建会话。
4. 使用 `SessionManager.inMemory()`，避免把一次问题的历史带入下一次问题。
5. 只启用 `read/grep/find/ls` 和四个只读 Docker 工具。

每次浏览器提问都会获得一个新会话。这样虽然没有预热池，但行为简单、隔离清晰，适合当前本地工具。

## Docker 自定义工具与只读白名单

`pi-docker-tools.js` 把现有 `DockerClient` 包装成四个结构化工具：

- `docker_list_containers`
- `docker_get_logs`
- `docker_search_logs`
- `docker_get_stats`

这些工具直接调用 Docker API，不经过 shell。会话通过 `tools` 白名单只开放上述
工具和 `read/grep/find/ls`，因此 Agent 无法调用 `bash/edit/write`。

## `PiAgent` 为什么仍然存在

页面不需要理解 PI 的全部事件类型，只关心以下内容：

| PI 事件 | 项目行为 |
|---|---|
| `message_update/text_delta` | 追加文本并调用 `onDelta` |
| `message_end` | 保存最终助手消息并调用 `onMessageEnd` |
| `tool_execution_start` | 调用 `onToolStart` |
| `tool_execution_end` | 调用 `onToolEnd` |
| `agent_end` | 调用 `onAgentEnd` 输出统计 |

其他事件由 PI 自己处理，本项目不建立第二套状态机。

`prompt()` 直接等待 PI 原生 Promise：

```js
await this.session.prompt(message, options);
```

因此不再需要自建 FIFO、请求 ID、ready 状态、结束回调或超时竞速。

分析过程中追加信息也直接使用 PI 原生队列：

```js
await agent.steer('重点查看 14:30 之后的日志');
await agent.followUp('再确认这次发布改了哪些配置');
```

- `steer()`：当前工具调用完成后，在下一次模型调用前加入信息；
- `followUp()`：当前 Agent 循环完成后，再自动处理补充问题。

`PiAgent` 只校验会话确实还在运行，不复制 PI 内部的消息队列。

## 快速分析和深度排障

页面只传递 `quick` 或 `deep`，服务端映射为 PI 原生思考等级：

| 页面模式 | `thinkingLevel` | 用途 |
|---|---|---|
| 快速分析 | `low` | 单行错误、直接解释 |
| 深度排障 | `high` | 允许进一步查询日志和源码 |

每个会话启动时都会用 `PI_PROVIDER` 和 `PI_MODEL` 查找真实模型，然后显式执行：

```js
await session.setModel(model);
session.setThinkingLevel(thinkingLevel);
```

这些设置只影响当前内存会话，不会改写 PI 的全局默认配置。
自定义模型还必须在 `models.json` 中声明 `"reasoning": true`；项目的
`scripts/setup-pi-auth.sh` 已负责写入，否则 PI 会把 `low/high` 降为 `off`。
为兼容已有的旧配置，服务端还会在内存模型上补齐这项能力声明；它不会读取、复制
或改写 API 密钥，也不会持久化修改 `~/.pi`。若换成不支持推理的模型，应设置
`PI_SUPPORTS_REASONING=0`，此时快速/深度模式会明确报错而不是假装生效。

## `PiAgentManager` 实际做什么

`PiAgentManager` 是一个很薄的生命周期管理器：

- `acquire()`：创建并启动一个独立 `PiAgent`；
- `release()`：释放指定 Agent；
- `shutdown()`：服务退出时释放所有仍在运行的 Agent。

如果以后确实出现会话初始化性能问题，再基于测量结果增加缓存或预热，不提前引入复杂度。

## 推荐阅读顺序

1. `createSession()`：了解 PI SDK 的最小接入方式。
2. `PiAgent.prompt()`：了解一次问题如何执行。
3. `PiAgent.steer()` / `followUp()`：了解分析中如何追加信息。
4. `PiAgent._onEvent()`：了解页面如何接收 PI 输出。
5. `PiAgentManager`：了解会话如何被创建和释放。
