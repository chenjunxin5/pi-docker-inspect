# 项目代码映射 — 设计

把"某个容器对应哪个代码仓库"的关系做成配置,让 PI 在分析这个容器的日志
时能 `read` / `grep` 进仓库,而不是凭空猜。

## 目标

```
ai_builder_celery 容器报错: KeyError: 'foo'
                  ↓
PI: 先 grep ~/projects/ai-builder-agent 看 'foo' 出现在哪,
   再 read 那个文件确认数据流,
   再回来引用 [Ln] + repo path 给出根因。
```

不是预拼上下文,只是给 PI **多一个目录可以走进去**。

## 数据流

```
config/projects.json
    ↓ loadProjects()  (启动时读一次)
src/projects.js  → Map<containerName, Project>
    ↓ findProjectForContainer(containerName)
src/ws-router.js  buildBrowserPrompt({...,sourceRepo})
    ↓ "[source-repo] /Users/SL/projects/ai-builder-agent ..."
pi --mode rpc  (PI 自己决定 grep/read)
    ↓
skill/SKILL.md 教它怎么用
```

## 配置

### `config/projects.json`

```json
{
  "ai_builder_celery": {
    "repo": "https://gitee.com/smilechenjx/ai-builder-agent.git",
    "branch": "main",
    "localPath": "~/projects/ai-builder-agent",
    "description": "Celery worker for ai-builder-agent (Python)"
  }
}
```

字段:

| 字段 | 必填 | 说明 |
|---|---|---|
| `repo` | 是 | git URL |
| `branch` | 否 | 默认 `main` |
| `localPath` | 是 | 本地绝对路径,支持 `~` 展开。**约定**:`~/projects/<repo-name>`,即 URL 最后一段去掉 `.git` |
| `description` | 否 | 一句话告诉 PI 这是什么项目,会出现在 `[source-repo]` hint 里 |

**键是容器名**(不是 id,不是 image):
- id 每次重启变,无法稳定映射
- image 有多个 tag(`foo:latest` / `foo:v1`),名字歧义
- 用户起的 name 是稳定的、有语义的

### 缺省行为

- `config/projects.json` 不存在 → 静默 no-op,不报错,prompt 不加 `[source-repo]`
- 容器名不在 mapping 里 → 同上
- `localPath` 还没 clone → 服务端在 `[source-repo]` hint 里照样写出路径,
  PI 调 `ls` 时会发现不存在,自己报错给用户(我们不替 PI 提前 clone)
- 但 `setup-projects.sh` 默认会**主动 clone**,所以正常流程下永远 ready

## 启动脚本

### `scripts/setup-projects.sh`

从 `config/projects.json` 读记录,对每条:

```
if .git 不存在:
    git clone --branch <branch> <repo> <localPath>
else:
    if working tree dirty (git status --porcelain 非空):
        echo "[projects] <name>: working tree dirty, skipping pull" >&2
        skip
    else:
        git fetch --quiet
        git pull --ff-only --quiet
        # 失败 → warn + skip (不要强 reset,会冲掉本地改动)
```

**两条安全网**:

1. dirty working tree → 跳过 pull(不破坏 `git status` 已有改动)
2. non-fast-forward → 跳过(可能是 force-push 进来的,或本地有未 push commit)

永远**不**跑 `git reset --hard` / `git clean -fd` 这种破坏性命令。

### 触发时机

- `./scripts/setup.sh` 末尾调一次(用户主动)
- `./scripts/restart.sh` 末尾调一次(`auto git pull` —— 服务器重启 = 顺手同步)
- 不在 server.js 启动时同步跑(避免冷启延迟 + 网络依赖进启动路径)

git fetch + pull 都是 `--quiet`,失败都只是 warn,**不让它们阻塞任何流程**。

## 服务端改动

### 新文件 `src/projects.js`

```js
function loadProjects(rootDir) {
  // 读 config/projects.json,~ 展开,失败 warn 返回 {}
}
function findProjectForContainer(projects, containerName) {
  // 精确匹配 name,找不到返回 null
}
```

### `src/ws-router.js`

启动时调一次 `loadProjects(...)`,把 mapping 存在 `attachWsRouter` 的闭包里。

`onAskLlm` 里:

```js
const project = findProjectForContainer(projects, containerName);
const promptMessage = buildBrowserPrompt({
  ...,
  sourceRepo: project
    ? { path: project.localPath, description: project.description }
    : null,
});
```

### `buildBrowserPrompt` 模板

新加可选段(放在 `[context]` 之后,`[skill-name]` 之前):

```
[source-repo] /Users/SL/projects/ai-builder-agent
  (Celery worker for ai-builder-agent; use ls/grep/read here when investigating errors)
```

只在 `sourceRepo` 非 null 时输出。其它段不变。

### 启动期 sanity log

`server.js` 启动 banner 多打一行,跟 auth/models 一样:

```
projects.json  : .../config/projects.json  [3 mappings: ai_builder_celery, …]
```

方便用户一眼看出 server 看到了哪些容器。

## SKILL.md 改动

### "何时加载" 段落加触发

> 用户问"为什么 redis 容器报这个错" / "分析下这个 KeyError" / "看看这个 traceback"
> → 优先 `read` `[source-repo]` 提示的目录,**先 grep 定位,再 read 关键文件**。

### 工作流加一段

```
3.5 错误涉及业务逻辑时:
    a. cd [source-repo] (从 prompt hint 里拿)
    b. rg "<error keyword>" --type py
    c. read 命中的关键文件
    d. 把 [Ln] (日志行号) + repo path:line 一起作为证据
```

### "Notes" 加一条警示

> 不要 `cat *.py` / `read` 整个目录。先 `ls` 看结构,`rg` 关键词,**只 read 必要的
> 文件**。每次 `read` 都消耗上下文;50 次 read 之内 context 就见底了。

## 风险

| 风险 | 缓解 |
|---|---|
| PI 过度 read 把 context 烧穿 | SKILL.md 强制 grep-first;仓库小(14 顶层条目)目前不构成问题 |
| 用户本地有未提交改动,被 pull 覆盖 | dirty → skip,non-ff → skip,**绝不 reset** |
| Repo 太老,API 已经过时 | 用户自管:`./scripts/setup-projects.sh` 随时手动跑;不绑 auto-update 时间 |
| Repo 是私有的,clone 到本机 | 用户责任;本项目只对接 git URL,不存凭据(SSH key 用系统默认) |
| 配错容器 → 喂错仓库 | 在 hint 里写出完整路径,用户从 prompt 就能看出,改 `projects.json` 即可 |
| Repo 巨大(如 mono-repo) | 当前仓库小,未来硬化:加 `paths` 白名单限定 PI 能 `cd` 进哪些子目录 |

## 改动 checklist (实施时)

1. ✅ `config/projects.json` — 加 ai_builder_celery 记录
2. ✅ `scripts/setup-projects.sh` — 写脚本,chmod +x,bash -n
3. ✅ `src/projects.js` — `loadProjects` + `findProjectForContainer`
4. ✅ `src/ws-router.js` — 启动时 load,onAskLlm 时 lookup,buildBrowserPrompt 加段
5. ✅ `server.js` — 启动 banner 加 projects 行
6. ✅ `scripts/setup.sh` — 末尾调 setup-projects.sh
7. ✅ `scripts/restart.sh` — 末尾调 setup-projects.sh
8. ✅ `skill/SKILL.md` — 加 [source-repo] 触发器 + 工作流第 3.5 步 + Notes 警示
9. ✅ `docs/browser-server.md` — `[source-repo]` 段加到 prompt 协议表
10. ✅ `docs/code-tour.md` — "代码阅读指引" 加一段说 config/projects.json 在哪
11. ✅ 跑一次 `./scripts/setup-projects.sh` clone 实仓库
12. ✅ restart server,ask_llm,确认 prompt 含 `[source-repo]` 且 PI 真的 read 了 repo

## 不做的事 (out of scope)

- ❌ 自动检测容器 → 仓库(根据 image / ENV 变量猜)——太玄学,易错
- ❌ 支持多仓库 / monorepo(一个 container → 多个 repo)——结构会乱,真要时再设计
- ❌ 把 [source-repo] 加到浏览器 UI(目前只在 server prompt 里)——暂不需要
- ❌ 私有仓库鉴权(`https://user:token@...` 或 SSH 配置)—— 用户自己配 SSH key
- ❌ 仓库版本锁定(`commit SHA` 而不是 `branch`)—— 当前用户说"自动 pull",锁了反而反着

## 一句话总结

> PI 已经会 `read` / `grep`;我们只是给它多一个目录指针。
> 配置驱动、setup 自动 clone、prompt 加一行 hint、SKILL.md 教它别瞎读。
