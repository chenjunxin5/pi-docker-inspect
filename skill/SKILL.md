---
name: docker-logs
description: 检查和分析本机 Docker 容器的日志、状态与资源占用。用户询问容器报错、崩溃、重启、性能或业务异常时使用。
---

# Docker 日志排障

使用项目提供的只读 Docker 工具收集证据。不要猜测容器状态，也不要尝试修改、重启或删除容器。

## 可用工具

- `docker_list_containers`：列出正在运行的容器。
- `docker_get_logs`：读取容器最近的日志，返回可引用的 `[L<n>]` 行号。
- `docker_search_logs`：使用字符串或正则搜索日志，并返回上下文。
- `docker_get_stats`：读取一次 CPU、内存和网络使用快照。
- `read`、`grep`、`find`、`ls`：只读检查提示词中 `[source-repo]` 指向的源码。

浏览器服务创建的会话不开放 `bash`、`edit` 和 `write`。其中的所有 Docker 操作
必须通过上述 Docker 工具完成；不要执行任何会修改容器状态的命令。

## 推荐流程

1. 容器不明确时，先调用 `docker_list_containers` 确认名称或 ID。
2. 排查一般错误时，先读取最近 200 行，再按 `ERROR|panic|fatal|exception|killed` 搜索上下文。
3. 排查健康或性能问题时，同时读取最近日志和 `docker_get_stats`。
4. 日志涉及字段缺失、状态异常或具体代码路径时，到 `[source-repo]` 中用只读工具定位相关源码。
5. 证据不足时明确说明缺少什么，不得编造。

## 回答要求

- 引用日志时保留 `[L<n>]` 行号。
- 引用源码时给出文件路径和行号。
- 区分直接根因、相关现象和待验证假设。
- 优先给出最小、可验证的下一步。
- 不建议通过重启或删除容器掩盖根因。
