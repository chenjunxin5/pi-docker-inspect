'use strict';

const path = require('node:path');
const { searchLines } = require('./search');
const { loadProjects, findProjectForContainer } = require('./projects');
const { ANALYSIS_MODES } = require('./pi-agent');

// PI 事件默认实时回传浏览器 (analysis_tool_call / _tool_update / _tool_result /
// _thinking_delta / _meta);旧版 PI_BROWSER_TRACE 开关已移除。
const PI_LOG_ARGS_MAX = parseInt(process.env.PI_LOG_ARGS_MAX || '160', 10);

/** Per-ask console logger — tags every line with [ask-xxx] and a timestamp. */
function makeAskLogger(askId) {
  const tag = askId ? String(askId) : '?';
  const ts = () => new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const fmt = (...parts) => console.log(`[pi] ${ts()} [${tag}]`, ...parts);
  return {
    start: ({ charCount }) => fmt(`▶ prompt sent (${charCount} chars)`),
    firstDelta: (ms) => fmt(`◀ first delta after ${(ms / 1000).toFixed(2)}s`),
    toolStart: ({ toolName, args }) => fmt(`🔧 ${toolName}`, summarizeArgs(args, PI_LOG_ARGS_MAX)),
    toolEnd: ({ toolName, isError, resultSize, durationMs }) => {
      const mark = isError ? '✗' : '✓';
      const size = Number.isFinite(resultSize) ? `${resultSize} bytes` : '?';
      const dur = `${(durationMs / 1000).toFixed(2)}s`;
      fmt(`  ${mark} ${toolName} → ${size} in ${dur}${isError ? ' (error)' : ''}`);
    },
    done: ({ partial, durationMs, textLength, stopReason, toolCallCount, errorToolCalls }) => {
      const dur = (durationMs / 1000).toFixed(2);
      const tcSummary = toolCallCount
        ? `${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'}${errorToolCalls ? ` (${errorToolCalls} error)` : ''}`
        : 'no tool calls';
      const label = partial ? '◀ aborted' : '◀ done';
      fmt(`${label} in ${dur}s, ${textLength} chars, stop=${stopReason || '?'}, ${tcSummary}`);
    },
    error: (err) => fmt(`✗ error: ${err && err.message ? err.message : err}`),
  };
}

function summarizeArgs(args, max) {
  let s;
  if (args == null) return '';
  if (typeof args === 'string') s = args;
  else {
    try { s = JSON.stringify(args); }
    catch (_) { s = String(args); }
  }
  if (s.length > max) s = s.slice(0, Math.max(0, max - 1)) + '…';
  return s;
}

/**
 * Wire the WebSocket server. Each connection owns private state:
 *   { selectedId, followHandle, lineBuffer, activeAsk, piClient }
 *
 * `investigations` 是服务级、按 containerId 粘合的会话管理器。
 * 没有它的时候,attachWsRouter 会自己建一个临时的 InvestigationManager,
 * 行为退化为"每个 ask 独立会话",和老版本一致。
 */
function attachWsRouter(wss, { docker, agentManager, projects, investigations }) {
  if (!investigations) {
    // 测试或老调用方可能不传,这里兜底建一个,行为和老版本对齐。
    const { InvestigationManager } = require('./investigation');
    investigations = new InvestigationManager({ agentManager });
  }
  const projectsInfo = projects || loadProjects(path.join(__dirname, '..'));
  wss.on('connection', (ws) => {
    const state = {
      selectedId: null,
      followHandle: null,
      lineBuffer: [],          // most-recent lines per selected container (capped)
      lineBufferCap: 5000,
      activeAsk: null,         // { askId, client, text }
    };

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    safeSend(ws, { type: 'hello', payload: { ts: Date.now() } });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch (_) { return; }

      const { type, payload = {} } = msg;
      switch (type) {
        case 'list_containers':      return onListContainers();
        case 'fetch_logs':           return onFetchLogs(payload);
        case 'start_follow':         return onStartFollow(payload);
        case 'stop_follow':          return onStopFollow(payload);
        case 'search_logs':          return onSearchLogs(payload);
        case 'ask_llm':              return onAskLlm(payload);
        case 'steer_ask':            return onAdditionalInput('steer', payload);
        case 'follow_up_ask':        return onAdditionalInput('followUp', payload);
        case 'abort_ask':            return onAbortAsk(payload);
        case 'close_investigation':  return onCloseInvestigation(payload);
        default:
          safeSend(ws, { type: 'error', payload: { code: 'BAD_TYPE', message: `unknown type: ${type}` } });
      }
    });

    ws.on('close', () => {
      try { state.followHandle?.stop(); } catch (_) { /* ignore */ }
      state.followHandle = null;
      // 中止当前问题。连接断开不释放会话：investigation 按 containerId 服务级缓存,
      // 等空闲超时或显式 close_investigation 再释放。
      if (state.activeAsk) {
        const a = state.activeAsk;
        a.client.abort().catch(() => { /* ignore */ });
        if (a.investigationContainerId) {
          investigations.markIdle(a.investigationContainerId);
        }
        state.activeAsk = null;
      }
    });

    // ---- handlers ----

    async function onListContainers() {
      try {
        const containers = await docker.listRunning();
        safeSend(ws, { type: 'containers', payload: { containers } });
      } catch (err) {
        safeSend(ws, { type: 'error', payload: { code: 'DOCKER_LIST', message: err.message } });
      }
    }

    async function onFetchLogs({ containerId, tail }) {
      if (!containerId) return safeSend(ws, { type: 'error', payload: { code: 'BAD_INPUT', message: 'containerId required' } });
      // Stop previous follow if switching container.
      if (state.selectedId !== containerId) {
        try { state.followHandle?.stop(); } catch (_) { /* ignore */ }
        state.followHandle = null;
        state.lineBuffer = [];
      }
      state.selectedId = containerId;
      const t = clamp(parseInt(tail, 10) || 500, 1, 100_000);
      try {
        const lines = await docker.fetchLogs(containerId, { tail: t });
        state.lineBuffer = lines.slice(-state.lineBufferCap);
        safeSend(ws, { type: 'logs', payload: { containerId, lines: state.lineBuffer, tail: t } });
      } catch (err) {
        safeSend(ws, { type: 'error', payload: { code: 'DOCKER_LOGS', message: err.message, containerId } });
      }
    }

    function onStartFollow({ containerId }) {
      if (!containerId) return safeSend(ws, { type: 'error', payload: { code: 'BAD_INPUT', message: 'containerId required' } });
      if (state.selectedId !== containerId) {
        try { state.followHandle?.stop(); } catch (_) { /* ignore */ }
        state.followHandle = null;
        state.lineBuffer = [];
        state.selectedId = containerId;
      } else if (state.followHandle) {
        return; // already following
      }
      const handle = docker.followLogs(containerId, {
        tail: 500,
        onLine: ({ stream, text, ts }) => {
          state.lineBuffer.push(`[${stream}] ${text}`);
          if (state.lineBuffer.length > state.lineBufferCap) {
            state.lineBuffer.splice(0, state.lineBuffer.length - state.lineBufferCap);
          }
          safeSend(ws, { type: 'log_line', payload: { containerId, stream, text, ts } });
        },
        onError: (err) => {
          safeSend(ws, { type: 'follow_stopped', payload: { containerId, reason: err.message } });
          state.followHandle = null;
        },
        onEnd: () => {
          safeSend(ws, { type: 'follow_stopped', payload: { containerId, reason: 'end' } });
          state.followHandle = null;
        },
      });
      state.followHandle = handle;
      safeSend(ws, { type: 'follow_started', payload: { containerId, ts: Date.now() } });
    }

    function onStopFollow({ containerId }) {
      if (state.followHandle && state.selectedId === containerId) {
        try { state.followHandle.stop(); } catch (_) { /* ignore */ }
        state.followHandle = null;
        safeSend(ws, { type: 'follow_stopped', payload: { containerId, reason: 'user' } });
      }
    }

    async function onSearchLogs({ containerId, query, mode, contextBefore, contextAfter }) {
      if (!containerId) return safeSend(ws, { type: 'error', payload: { code: 'BAD_INPUT', message: 'containerId required' } });
      // Use the in-memory buffer when following the same one; otherwise fetch a tail snapshot.
      let lines;
      if (state.selectedId === containerId && state.lineBuffer.length > 0) {
        lines = state.lineBuffer;
      } else {
        try { lines = await docker.fetchLogs(containerId, { tail: 500 }); }
        catch (err) {
          return safeSend(ws, { type: 'error', payload: { code: 'DOCKER_LOGS', message: err.message, containerId } });
        }
      }
      // Strip "[stdout] " / "[stderr] " prefixes when searching.
      const stripped = lines.map((l) => stripStreamPrefix(l));
      const result = searchLines(stripped, { query, mode, contextBefore, contextAfter });
      if (result.error) {
        return safeSend(ws, { type: 'search_results', payload: { containerId, error: result.error, message: result.message } });
      }
      safeSend(ws, { type: 'search_results', payload: { containerId, matches: result.matches, truncated: result.truncated, totalScanned: result.totalScanned } });
    }

    async function onAskLlm({
      askId, containerId, containerName, matches, userQuestion, analysisMode = 'quick',
    }) {
      if (!askId || !userQuestion) {
        return safeSend(ws, { type: 'error', payload: { code: 'BAD_INPUT', message: 'askId, userQuestion required' } });
      }
      if (!ANALYSIS_MODES[analysisMode]) {
        return safeSend(ws, {
          type: 'analysis_error',
          payload: { askId, message: `unknown analysis mode: ${analysisMode}` },
        });
      }
      // matches is now optional — PI's agent decides whether to use the
      // browser-side selection as a hint or query the skill tools fresh.

      // Abort any in-flight ask on this connection first.
      if (state.activeAsk) {
        const prev = state.activeAsk;
        safeSend(ws, { type: 'analysis_done', payload: { askId: prev.askId, fullText: prev.text, partial: true, reason: 'superseded' } });
        try { await prev.client.abort(); } catch (_) { /* ignore */ }
        // investigation 拥有的会话不释放,只清 busy 标记。
        if (prev.investigationContainerId) {
          investigations.markIdle(prev.investigationContainerId);
        }
        state.activeAsk = null;
      }

      // 走 investigation:同一 containerId 在空闲窗口内复用同一会话。
      let client;
      let reused;
      try {
        const acquired = await investigations.acquire({ containerId, analysisMode });
        if (acquired.busy) {
          return safeSend(ws, {
            type: 'analysis_error',
            payload: { askId, message: '该容器的会话正在处理另一个问题,请稍后再试' },
          });
        }
        client = acquired.client;
        reused = acquired.reused;
      } catch (err) {
        return safeSend(ws, { type: 'analysis_error', payload: { askId, message: `pool acquire failed: ${err.message}` } });
      }

      investigations.markBusy(containerId);
      const ask = {
        askId, client, text: '', _t0: Date.now(),
        investigationContainerId: containerId,
      };
      state.activeAsk = ask;
      safeSend(ws, {
        type: 'analysis_started',
        payload: {
          askId,
          analysisMode,
          investigation: reused
            ? { containerId, containerName, reused: true }
            : { containerId, containerName, reused: false },
        },
      });
      // 告诉前端本轮配置 (是否启用 thinking 流)。当前所有支持的模型都允许
      // 接收 thinking_delta,这里统一发 true;后续若按模型细控,改成派生值即可。
      safeSend(ws, {
        type: 'analysis_meta',
        payload: { askId, hasThinkingSupport: true },
      });

      // Forward the raw question to PI. The docker-logs skill is auto-loaded
      // (via the symlink in ~/.pi/agent/skills/docker-logs/) so PI can use the
      // read-only Docker tools to gather any extra context it needs.
      const project = findProjectForContainer(projectsInfo, containerName);
      const sourceRepo = project
        ? { path: project.localPath, description: project.description }
        : null;
      // 复用会话时只发精简 prompt;PI 已经持有该 container 的上下文。
      const promptMessage = reused
        ? buildFollowUpPrompt({ containerName, matches, userQuestion })
        : buildBrowserPrompt({
            containerName, containerId, matches, userQuestion,
            sourceRepo, analysisMode,
          });

      // Per-ask console logger — emit one line for each PI event so the
      // operator can tail server.js and watch the agent loop.
      const log = makeAskLogger(askId);
      log.start({ charCount: promptMessage.length });

      let firstDeltaLogged = false;

      // PI 工具事件:同时写控制台日志(摘要)和回传浏览器(完整 args + 摘要 label)。
      // 之前用 PI_BROWSER_TRACE 开关;现在默认一直回传,让页面能实时看到工具进展。
      const onToolStart = (evt) => {
        log.toolStart(evt);
        safeSend(ws, {
          type: 'analysis_tool_call',
          payload: {
            askId,
            toolName: evt.toolName,
            toolCallId: evt.toolCallId,
            args: evt.args,
            argsSummary: summarizeArgs(evt.args, PI_LOG_ARGS_MAX),
          },
        });
      };
      const onToolUpdate = (evt) => {
        // 部分工具(grep/read/docker_search_logs 等)会在执行中触发 onUpdate
        // 回传 partialResult,这里把它们冒泡给前端做"实时输出"动画。
        safeSend(ws, {
          type: 'analysis_tool_update',
          payload: {
            askId,
            toolName: evt.toolName,
            toolCallId: evt.toolCallId,
            partialResult: evt.partialResult,
          },
        });
      };
      const onToolEnd = (evt) => {
        log.toolEnd(evt);
        safeSend(ws, {
          type: 'analysis_tool_result',
          payload: {
            askId, toolName: evt.toolName, toolCallId: evt.toolCallId,
            isError: evt.isError, resultSize: evt.resultSize, durationMs: evt.durationMs,
          },
        });
      };
      // PI 完成整轮处理时记录汇总信息。
      const onAgentEnd = (summary) => log.done(summary);

      client.prompt({ message: promptMessage }, {
        onDelta: (delta) => {
          if (!firstDeltaLogged) {
            firstDeltaLogged = true;
            const ms = Date.now() - ask._t0;
            log.firstDelta(ms);
          }
          ask.text += delta;
          safeSend(ws, { type: 'analysis_delta', payload: { askId, delta } });
        },
        onThinkingDelta: (delta) => {
          // 模型推理文本。控制台不重写(冗余),只冒泡给前端展示。
          safeSend(ws, { type: 'analysis_thinking_delta', payload: { askId, delta } });
        },
        onToolUpdate,
        onMessageEnd: (message) => {
          safeSend(ws, { type: 'analysis_message_end', payload: { askId, stopReason: message?.stopReason || null } });
        },
        onToolStart,
        onToolEnd,
        onAgentEnd,
      }).then((result) => {
        safeSend(ws, {
          type: 'analysis_done',
          payload: { askId, fullText: result.text, partial: !!result.partial },
        });
        if (state.activeAsk === ask) state.activeAsk = null;
        // 会话不释放,留给下一次 ask 复用。
        investigations.markIdle(containerId);
      }).catch((err) => {
        log.error(err);
        safeSend(ws, { type: 'analysis_error', payload: { askId, message: err.message } });
        if (state.activeAsk === ask) state.activeAsk = null;
        investigations.markIdle(containerId);
      });
    }

    /**
     * 给当前 PI 分析追加信息。
     * steer 会在当前工具结束后尽快送入；followUp 会等当前分析自然结束后再送入。
     */
    async function onAdditionalInput(mode, { askId, message }) {
      const ask = state.activeAsk;
      const text = typeof message === 'string' ? message.trim() : '';

      if (!ask || ask.askId !== askId) {
        return safeSend(ws, {
          type: 'analysis_input_error',
          payload: { askId, mode, message: '当前分析已结束或任务编号不匹配' },
        });
      }
      if (!text) {
        return safeSend(ws, {
          type: 'analysis_input_error',
          payload: { askId, mode, message: '补充信息不能为空' },
        });
      }

      try {
        if (mode === 'steer') await ask.client.steer(text);
        else await ask.client.followUp(text);
        safeSend(ws, {
          type: 'analysis_input_accepted',
          payload: { askId, mode, message: text },
        });
      } catch (err) {
        safeSend(ws, {
          type: 'analysis_input_error',
          payload: { askId, mode, message: err.message },
        });
      }
    }

    function onAbortAsk({ askId }) {
      const ask = state.activeAsk;
      if (!ask || ask.askId !== askId) return;
      ask.client.abort().catch(() => { /* ignore */ }).finally(() => {
        // 会话不释放:investigation 会保留下来,下次同 container 的 ask 仍可复用。
        investigations.markIdle(ask.investigationContainerId);
        if (state.activeAsk === ask) state.activeAsk = null;
      });
    }

    /**
     * 用户主动关闭某个 container 的持续排障会话。
     * 如果当前正好有 ask 在跑,先 abort,再释放会话。
     */
    function onCloseInvestigation({ containerId }) {
      if (!containerId) return;
      const activeOnThis = state.activeAsk && state.activeAsk.investigationContainerId === containerId;
      if (activeOnThis) {
        const a = state.activeAsk;
        state.activeAsk = null;
        a.client.abort().catch(() => { /* ignore */ }).finally(() => {
          investigations.close(containerId);
          safeSend(ws, { type: 'investigation_closed', payload: { containerId } });
        });
      } else {
        const released = investigations.close(containerId);
        if (released) safeSend(ws, { type: 'investigation_closed', payload: { containerId } });
      }
    }
  });
}

function buildBrowserPrompt({
  containerName, containerId, matches, userQuestion, sourceRepo, analysisMode = 'quick',
}) {
  // Minimal prompt — PI is the brain. We just hand it:
  //   1. what the user is currently looking at (optional context, not gospel),
  //   2. (optional) the source repo path so PI can grep/read application code,
  //   3. the user's question.
  // PI may call the read-only Docker tools to gather more context, or trust the
  // browser-side selection if it's sufficient.
  const sections = [];

  sections.push(`[context] docker-logs UI is showing logs for: ${containerName || 'unknown'}` +
    (containerId ? ` (id: ${containerId})` : ''));
  if (sourceRepo && sourceRepo.path) {
    const desc = sourceRepo.description ? ` — ${sourceRepo.description}` : '';
    sections.push(`[source-repo] ${sourceRepo.path}${desc}`);
  }
  sections.push(`[skill-name] docker-logs`);
  sections.push(analysisMode === 'deep'
    ? '[analysis-mode] deep: inspect additional logs and source code when useful'
    : '[analysis-mode] quick: prefer a concise answer from the provided evidence');

  const renderedMatches = renderMatchesWithContext(matches);
  if (renderedMatches) {
    sections.push('');
    sections.push(
      '[browser-highlighted-matches] '
      + '(lines wrapped in >>...<< are the user-selected hits; '
      + 'others are surrounding context for those hits. '
      + 'You may also re-query with the read-only Docker tools.)',
    );
    for (const line of renderedMatches) sections.push(line);
  }

  sections.push('');
  sections.push('---');
  sections.push('');
  sections.push(`[user-question] ${userQuestion}`);

  return sections.join('\n');
}

/**
 * 持续排障会话的精简 prompt。PI 已经持有该 container 的上下文,
 * 这里只发本轮新增的 matches(如果有)和用户问题,避免每次重复同一堆路径和说明。
 */
function buildFollowUpPrompt({ containerName, matches, userQuestion }) {
  const sections = [];
  sections.push(`[context] continuing investigation for container: ${containerName || 'unknown'}`);
  sections.push('[note] previous Q&A are still in your memory; only NEW matches are listed below');
  const renderedMatches = renderMatchesWithContext(matches);
  if (renderedMatches) {
    sections.push('');
    sections.push('[browser-highlighted-matches]');
    for (const line of renderedMatches) sections.push(line);
  }
  sections.push('');
  sections.push('---');
  sections.push('');
  sections.push(`[user-question] ${userQuestion}`);
  return sections.join('\n');
}

/**
 * 把 matches 数组展开成"按行号排序、去重、区分命中/上下文"的行列表。
 *
 * 输入 matches 形如 [{ lineNo, text, before: [text, ...], after: [text, ...] }]，
 * 由 src/search.js 计算时已经按行号排列上下文，但同一物理行可能被多个 match 的
 * before/after 覆盖（甚至同时是另一个 match 的命中行）。
 *
 * 输出：
 *   - 同一行只出现一次
 *   - 同一行被某个 match 命中时，标记为命中（即使它也是别的 match 的上下文）
 *   - 命中行用 '>>[L<no>] text<<' 标记；上下文行用 '  [L<no>] text'
 *
 * 返回 null 表示没有 match。
 */
function renderMatchesWithContext(matches) {
  if (!Array.isArray(matches) || matches.length === 0) return null;

  // lineNo -> { text, isHit }
  const lines = new Map();

  // 先把每个 match 的 before/after 记为上下文行；已存在的行不覆盖。
  for (const m of matches) {
    if (!Number.isFinite(m.lineNo)) continue;
    const before = Array.isArray(m.before) ? m.before : [];
    const after = Array.isArray(m.after) ? m.after : [];
    for (let k = 0; k < before.length; k++) {
      const lineNo = m.lineNo - (k + 1);
      if (lineNo >= 1 && !lines.has(lineNo)) {
        lines.set(lineNo, { text: before[k], isHit: false });
      }
    }
    for (let k = 0; k < after.length; k++) {
      const lineNo = m.lineNo + (k + 1);
      if (!lines.has(lineNo)) {
        lines.set(lineNo, { text: after[k], isHit: false });
      }
    }
  }

  // 再标记命中行；如果已被记录为上下文行，提升为命中行。
  for (const m of matches) {
    if (!Number.isFinite(m.lineNo)) continue;
    lines.set(m.lineNo, { text: m.text, isHit: true });
  }

  return [...lines.entries()]
    .sort(([a], [b]) => a - b)
    .map(([lineNo, { text, isHit }]) =>
      isHit ? `  >>[L${lineNo}] ${text}<<` : `    [L${lineNo}] ${text}`);
}

function stripStreamPrefix(line) {
  const m = /^\[(stdout|stderr)\]\s?/.exec(line);
  return m ? line.slice(m[0].length) : line;
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function safeSend(ws, obj) {
  if (ws.readyState !== ws.OPEN && ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); }
  catch (_) { /* ignore */ }
}

module.exports = { attachWsRouter, buildBrowserPrompt, buildFollowUpPrompt, summarizeArgs };
