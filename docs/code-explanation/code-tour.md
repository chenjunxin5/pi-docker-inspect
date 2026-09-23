# 代码阅读指引

第一次接手 PI 项目的速通手册。先读这份,再按它指的路去翻其它文档。

## 5 分钟路线图

```
1.  docs/architecture.md        →  三层架构 + 为什么这么设计 (View / Bridge / Brain)
2.  skill/SKILL.md              →  PI 实际看到的东西 (description + 脚本清单)
3.  src/pi-agent.js 顶部 60 行  →  ESM 互操作、ModelRuntime 单例、tool-call 守卫 (最微妙的一块)
4.  src/ws-router.js onAskLlm   →  浏览器 → PI 的事件映射
5.  src/docker.js               →  dockerode 封装 + 8 字节 demux
6.  docs/pi-agent-explained.md  →  SDK 事件 → 业务事件的 router 细节
```

读完后回来看本文档的"踩坑提醒"和"改动 checklist"。

## 推荐阅读顺序

### 第 1 步:先把架构跑起来

```bash
./scripts/restart.sh       # 看 server.log 的 [pi] 日志怎么流
open http://localhost:3000  # 点几个容器,搜一下,Ask LLM 一次
```

边看边对照 `docs/architecture.md` 的 ASCII 图。**先建立"哪一层在做什么"的心智模型**,
再去翻代码会顺得多。

### 第 2 步:读 skill

`skill/SKILL.md` 是 PI 视角下的"产品说明书"。注意:

- **frontmatter 的 `description`** 一直留在 system prompt 里 —— 是 progressive
  disclosure 的入口,得写得具体、触发词丰富。
- **body 是按需加载**的 —— PI 用内置 `read` 工具读 `SKILL.md` 才看得到。
- 浏览器会话使用 `src/pi-docker-tools.js` 中的四个结构化只读工具。
- `docker_get_logs` 返回 `[Ln]` 行号，这是后续让 PI 在回答里引用证据的基础。

### 第 3 步:读 PI library 适配器(`src/pi-agent.js`)

这是项目与 PI 的薄适配层。先看顶部注释、`createSession()` 和 `_onEvent()`，
把以下问题答出来再往下:

- 为什么用 `import('@earendil-works/pi-coding-agent')` 动态 import?(答:库是 ESM-only,
  项目是 CommonJS;动态 import 是最小侵入的互操作)
- 为什么直接等待 `session.prompt()`?(答:PI 已经负责完整 Agent 循环和自动重试，
  项目无需再实现一套 Promise 结算状态机)
- 为什么每次提问创建新会话?(答:避免上一次问题的上下文影响下一次分析)

读完 `prompt()` 方法再看 `_onEvent()` —— 这里把 SDK 事件
(`message_update` / `tool_execution_*` / `agent_end`) 转给页面回调。
**text 是怎么从 PI 流到浏览器的全在这一段**。

`docs/pi-agent-explained.md` 对这块有完整的事件路由。

### 第 4 步:读 WS 路由(`src/ws-router.js`)

整文件核心是 `onAskLlm`(约 200-300 行)。读时盯紧这几个点:

- `state.activeAsk` —— 每连接一个,新 ask 进来前先 abort 旧的(行号靠前那段)。
- `client.prompt(...)` 的 `onDelta` 回调里把 delta 累到 `ask.text` 并发
  `analysis_delta` 给浏览器。`onMessageEnd` 转发 `stopReason`,`.then()`
  转发 `analysis_done`,`.catch()` 转发 `analysis_error`。
- 顶部的 `makeAskLogger(askId)` —— 每个 ask 配一个 console 标签 logger,接收
  `onToolStart`/`onToolEnd`/`onAgentEnd` 回调,产生 `[pi] HH:MM:SS.mmm [ask-xxx] 🔧 docker_search_logs …`
  这种可 grep 的控制台输出。这一层是**把 PI 的事件流翻译成运维友好的文本**。

`buildBrowserPrompt`(文件底部)只负责把 `[context]`/`[skill-name]`/
`[browser-highlighted-matches]`/`[user-question]` 这五段拼起来。**故意做小**:
我们不预拼分析 prompt,推理交给 PI 的 agent loop 自己来。

### 第 5 步:读 docker 封装(`src/docker.js`)

`fetchLogs` 里有 8 字节 demux 的逻辑:

```
byte 0    = stream type (1=stdout, 2=stderr)
bytes 4-7 = uint32 BE payload size
bytes 8.. = payload
```

老版本 docker engine 直接发 raw stream,新版本会自动 demux 成 `{stdout, stderr}`
对象 —— 两个分支都要兼顾。`followLogs` 还要处理高频日志的背压:
- 5000 行 ring buffer(`lineBufferCap`)
- 5MB raw buffer 高水位 → `source.pause()`
- 单行 > 64KB 丢 + warn(防止 stack trace 把 WS 撑爆)

### 第 6 步:看 SDK 事件路由对照表

`docs/pi-agent-explained.md` 是**反向索引**:从"SDK 给我们推什么 / 我们怎么
转成业务回调"的角度描述适配层。读到这里你应该能扫一眼就知道 `_onEvent()`
处理了哪些事件、忽略了哪些事件、为什么。

## PI 关键概念速通(第一次必须懂)

| 概念 | 一句话 | 看哪里 |
|---|---|---|
| **Library 模式** | `createAgentSession()` 在进程内构造 `AgentSession`,事件通过 `session.subscribe()` 回调 | `docs/pi-agent-explained.md` |
| **Skill** | `~/.pi/agent/skills/<name>/SKILL.md`,PI 每个 session 自动加载 | `skill/SKILL.md` 及其 frontmatter(见下) |
| **Progressive disclosure** | 只有 `description` 留在 system prompt;body 按需 `read` | skill.md 顶部注释 |
| **独立会话** | 每次提问创建新 session，结束后立即 `dispose()` | `src/pi-agent.js` 的 `PiAgentManager` |
| **原生 Promise** | 直接等待 `session.prompt()`，工具循环和重试交给 PI | `src/pi-agent.js` 的 `PiAgent.prompt` |
| **只读工具白名单** | 仅开放源码读取和四个 Docker 自定义工具 | `src/pi-docker-tools.js` + `createSession()` |
| **Custom provider** | `~/.pi/agent/models.json` 覆盖内置 provider 的 `baseUrl` | `scripts/setup-pi-auth.sh` |
| **项目代码映射** | `config/projects.json` 把容器名绑到源码仓库,PI 在 ask 里多收 `[source-repo]` hint | `docs/projects-mapping.md` |

### SKILL.md frontmatter 三件套

`skill/SKILL.md` 顶部那段 YAML 是 PI 决定「要不要加载 / 怎么加载」的全部依据:

```yaml
---
name: docker-logs
description: 检查和分析本机 Docker 容器的日志、状态与资源占用……
---
```

三个字段需要重点理解:

1. **`name`** —— 决定技能命令 `/skill:<name>`,跟目录名对齐。
2. **`description`** —— **常驻上下文**;写得越具体、塞的触发词越多,PI 越不会错过匹配。
   浏览器提的问题里也会带 `[skill-name] docker-logs` 提示 PI 复用。
3. **正文 body** —— 按需加载,PI 用内置 `read` 工具读 `SKILL.md` 才看得到;写工具说明、推荐
   工作流、回答规范都可以。

## 三个最容易踩的坑

### 1. 改 `src/pi-agent.js` 后忘了 ESM 互操作的边界

`@earendil-works/pi-coding-agent` 是 ESM-only,本项目是 CommonJS。两者靠**一个**
`piLibPromise = import(...)` 在文件顶部互操作。如果你在 `src/pi-agent.js` 之外
的任意地方 `require('@earendil-works/pi-coding-agent')`,Node 会直接抛
`ERR_REQUIRE_ESM`。需要新符号时:**先 `await piLibPromise`**,或者把它接到
顶层缓存 promise 里。

### 2. 改 prompt template 不要塞太多

最初的设计在 server 端预拼完整的分析 prompt template(把容器名、上下文窗口、
回答格式都钉死)。问题:模板里没抽到的信息 LLM 永远看不到,追问也得重新提。

现在反过来:server 只发"[context] / [skill-name] / 可选
[browser-highlighted-matches] / [user-question]"五段极简 hint,**让 PI 决定**
要不要自己再 `read SKILL.md` 或调用 Docker 工具拉数据。

新功能要加时,问自己:**这是 PI 该自己判断的,还是必须在 hint 里钉死的?**
绝大多数情况是前者。

### 3. 改 skill 时记得 symlink

skill 是 `npm run skill:link` 软链到 `~/.pi/agent/skills/docker-logs` 的。
PI 在 session 创建时加载 skill 元数据。当前实现每次提问都会创建新会话，
因此修改 `SKILL.md` 后重新提问即可加载新版。

## 改东西时的 checklist

| 改什么 | 注意 |
|---|---|
| `skill/SKILL.md` 描述 | `description` 改完直接生效(symlink),但**当前 PI session 不会重新加载**,需要发新 ask 触发 fresh session |
| `src/pi-agent.js` | 改完必须**重启 server**(`./scripts/restart.sh`)。node 不会 hot-reload 子模块 |
| `src/ws-router.js` | 同上 |
| `server.js` | 同上 |
| `package.json` 依赖 | `npm install` + 重启 |
| `~/.pi/agent/models.json` | 改完**只对下次 `createAgentSession` 的 session 生效**;已经在跑的不会重新读 |
| `config/projects.json` | 新增映射后**必须重启 server**(读一次缓存进闭包)。`setup.sh` / `restart.sh` 末尾会自动同步仓库;手动触发 `./scripts/setup-projects.sh` |
| 新增 WS 消息 | 改 `docs/browser-server.md` 协议表 + `public/app.js` 事件处理 |
| 新增 SDK 事件 | 改 `src/pi-agent.js` 的 `_onEvent()` + 在事件表里说明用途 |

## 调试快捷键

```bash
# 1. 看 PI 在做什么(每个 ask 一组日志,标了 askId)
tail -f server.log | grep '\[pi\]'

# 2. 在 Node REPL 里直接驱动 PI(不走 server)
node -e "(async()=>{const{createAgentSession,ModelRuntime}=await import('@earendil-works/pi-coding-agent');const rt=await ModelRuntime.create();const s=await createAgentSession({cwd:process.cwd(),modelRuntime:rt});s.subscribe(e=>console.log(JSON.stringify(e.type)));await s.prompt('Use docker-logs skill: list containers');})()"

# 3. WS 协议级 smoke
node scripts/ws-smoke.js

# 4. Playwright E2E(浏览器)
node scripts/browser-smoke.js
```

## 一句话总结

> PI 是大脑,server 是管道,skill 是手脚。
> 浏览器只发用户问题,PI 自己决定怎么查、查什么、怎么答。
> 改任何东西前先想:**这是 PI 该自己做的,还是必须在管道里钉死的?**
