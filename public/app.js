'use strict';

/**
 * Alpine.js components + WS client for docker-logs-agent.
 *
 * Architecture:
 *   - Alpine.store('app') is the reactive global state (WS, status, etc.).
 *   - Each component (loader/containerList/logViewer/analysisPanel) registers
 *     itself on `Alpine.store('app')._refs.<name>` in init() and reads
 *     $store.app.send() to talk to the server.
 *   - A tiny event bus decouples components from raw WS messages.
 *
 * Use Alpine.store() (not a plain global) so that assignments like
 * store.wsReady = true propagate to all bound expressions.
 */

document.addEventListener('alpine:init', () => {
  Alpine.store('app', {
    ws: null,
    wsReady: false,
    statusText: 'connecting…',
    reconnectDelay: 1000,
    reconnectTimer: null,

    _refs: { containerList: null, logViewer: null, analysisPanel: null },
    _started: false,

    // Connect the WS exactly once, idempotently. Safe to call multiple times.
    _start() {
      if (this._started) return;
      this._started = true;
      this._connect();
      bus.on('list_containers', () => this.send({ type: 'list_containers' }));
    },
    _connect() {
      if (this.ws) { try { this.ws.close(); } catch (_) {} }
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      this.ws = ws;
      ws.onopen = () => {
        this.wsReady = true;
        this.reconnectDelay = 1000;
        this.statusText = 'connected';
        bus.emit('ws_open');
        this.send({ type: 'list_containers' });
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        bus.emit(msg.type, msg.payload || {});
      };
      ws.onerror = () => { this.statusText = 'error'; };
      ws.onclose = () => {
        this.wsReady = false;
        this.statusText = 'disconnected · retrying';
        bus.emit('ws_close');
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this._connect(),
          Math.min(30_000, this.reconnectDelay));
        this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
      };
    },
    send(obj) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      try { this.ws.send(JSON.stringify(obj)); return true; }
      catch (_) { return false; }
    },
    refreshContainers() { this.send({ type: 'list_containers' }); },
  });
});

const bus = (() => {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event)?.delete(fn);
    },
    emit(event, payload) {
      const set = handlers.get(event);
      if (!set) return;
      for (const fn of set) {
        try { fn(payload); } catch (err) { console.error('[bus]', err); }
      }
    },
  };
})();

/**
 * Mirror of `summarizeArgs` in src/ws-router.js — keep in lock-step so the
 * browser label matches the server console truncation (single `…` ellipsis).
 */
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

const $store = () => Alpine.store('app');

function loader() {
  return {
    // Kick off the WS once. The store's _start() is idempotent.
    init() { $store()._start(); },
    get wsReady() { return $store().wsReady; },
    get statusText() { return $store().statusText; },
    refreshContainers() { $store().refreshContainers(); },
  };
}

function containerList() {
  return {
    containers: [],
    selectedId: null,
    loading: false,
    _off: [],
    init() {
      $store()._refs.containerList = this;
      this._off.push(bus.on('containers', ({ containers }) => {
        this.containers = Array.isArray(containers) ? containers : [];
        this.loading = false;
        if (!this.selectedId && this.containers.length > 0) {
          this.select(this.containers[0]);
        } else if (this.selectedId) {
          const c = this.containers.find((x) => x.id === this.selectedId);
          if (c && $store()._refs.logViewer) $store()._refs.logViewer.selectedName = c.name;
        }
      }));
      this._off.push(bus.on('ws_open', () => $store().send({ type: 'list_containers' })));
    },
    destroy() { for (const off of this._off) try { off(); } catch (_) {} },
    select(c) {
      this.selectedId = c.id;
      if ($store()._refs.logViewer) $store()._refs.logViewer.selectedName = c.name;
      $store().send({ type: 'fetch_logs', payload: { containerId: c.id, tail: 500 } });
    },
    formatPorts(ports) {
      if (!ports || ports.length === 0) return '';
      return ports
        .filter((p) => p.publicPort)
        .map((p) => `${p.publicPort}→${p.privatePort}/${p.type}`)
        .slice(0, 4).join(', ');
    },
  };
}

function logViewer() {
  return {
    selectedId: null,
    selectedName: '',
    lines: [],
    followOn: false,
    searchQuery: '',
    searchMode: 'substring',
    contextN: 10,
    matches: null,
    matchesStatus: '',
    // 用户手动选中的 lineNo 列表(1-based)。
    // 搜索命中行也会自动加入;用户可取消勾选或额外勾选未搜到的行。
    selectedLines: [],
    _stickToBottom: true,
    _off: [],
    init() {
      $store()._refs.logViewer = this;
      const self = this;
      this._off.push(bus.on('ws_open', () => {
        if (self.selectedId) {
          $store().send({ type: 'fetch_logs', payload: { containerId: self.selectedId, tail: 500 } });
          if (self.followOn) $store().send({ type: 'start_follow', payload: { containerId: self.selectedId } });
        }
      }));
      this._off.push(bus.on('logs', ({ containerId, lines }) => {
        self.selectedId = containerId;
        self.lines = Array.isArray(lines) ? lines : [];
        // 切换容器/重拉日志 → 清掉旧选区,避免引用错位。
        self.selectedLines = [];
        self._scrollToBottomNext();
        const c = $store()._refs.containerList?.containers.find((x) => x.id === containerId);
        if (c) self.selectedName = c.name;
      }));
      this._off.push(bus.on('log_line', ({ containerId, text }) => {
        if (containerId !== self.selectedId) return;
        self.lines.push(`[stdout] ${text}`);
        if (self.lines.length > 5000) self.lines.splice(0, self.lines.length - 5000);
        if (self.followOn && self._stickToBottom) self._scrollToBottomNext();
      }));
      this._off.push(bus.on('follow_stopped', () => { self.followOn = false; }));
    },
    destroy() { for (const off of this._off) try { off(); } catch (_) {} },
    onScroll() {
      const root = this.$refs.logScroller;
      if (!root) return;
      this._stickToBottom = (root.scrollTop + root.clientHeight) >= (root.scrollHeight - 8);
    },
    _scrollToBottomNext() {
      this.$nextTick(() => {
        const r = this.$refs.logScroller;
        if (r) r.scrollTop = r.scrollHeight;
      });
    },
    toggleFollow() {
      if (!this.selectedId) { this.followOn = false; return; }
      if (this.followOn) {
        $store().send({ type: 'start_follow', payload: { containerId: this.selectedId } });
      } else {
        $store().send({ type: 'stop_follow', payload: { containerId: this.selectedId } });
      }
    },
    refetch() {
      if (!this.selectedId) return;
      // 重拉后行号意义变化 → 选区失效,清掉。
      this.selectedLines = [];
      $store().send({ type: 'fetch_logs', payload: { containerId: this.selectedId, tail: 500 } });
    },
    toggleSelect(lineNo) {
      if (!Number.isFinite(lineNo) || lineNo < 1) return;
      const i = this.selectedLines.indexOf(lineNo);
      if (i === -1) this.selectedLines.push(lineNo);
      else this.selectedLines.splice(i, 1);
    },
    isSelected(lineNo) {
      return this.selectedLines.includes(lineNo);
    },
    clearSelection() {
      this.selectedLines = [];
    },
    doSearch() {
      if (!this.selectedId || !this.searchQuery) return;
      $store().send({
        type: 'search_logs',
        payload: {
          containerId: this.selectedId,
          query: this.searchQuery,
          mode: this.searchMode,
          contextBefore: this.contextN,
          contextAfter: this.contextN,
        },
      });
      const off = bus.on('search_results', (p) => {
        if (!p || p.containerId !== this.selectedId) return;
        if (p.error) {
          this.matchesStatus = `error: ${p.error}${p.message ? ' — ' + p.message : ''}`;
          this.matches = [];
          off();
          return;
        }
        this.matches = Array.isArray(p.matches) ? p.matches : [];
        // 搜索命中行自动加入选区 —— 保留"一键选中所有命中"的旧体验。
        // 用户仍可点击行取消勾选。
        const hitLineNos = this.matches.map((m) => m.lineNo);
        const set = new Set(this.selectedLines);
        for (const ln of hitLineNos) set.add(ln);
        this.selectedLines = [...set].sort((a, b) => a - b);
        this.matchesStatus = p.truncated
          ? `${this.matches.length} matches (search truncated at ${p.totalScanned} lines scanned)`
          : `${this.matches.length} matches in ${p.totalScanned} lines`;
        off();
      });
    },
    clearSearch() {
      this.matches = null;
      this.matchesStatus = '';
    },
    pad(n) { return String(n).padStart(5, ' '); },
    lineClass(line, idx) {
      if (typeof line !== 'string') return 'log-line log-stdout';
      if (line.startsWith('[stderr]')) return 'log-line log-stderr';
      const lineNo = idx + 1;
      const isSelected = this.isSelected(lineNo);
      const isMatch = this.matches && this.matches.some((m) => m && m.lineNo === lineNo);
      if (isSelected && isMatch) return 'log-line log-stdout log-match log-selected';
      if (isSelected) return 'log-line log-stdout log-selected';
      if (isMatch) return 'log-line log-stdout log-match';
      return 'log-line log-stdout';
    },
  };
}

function analysisPanel() {
  return {
    userQuestion: '',
    analysisMode: 'quick',
    answerText: '',
    additionalMessage: '',
    additionalStatus: '',
    additionalStatusIsError: false,
    acceptedInputs: [],
    state: 'idle',
    errorMessage: '',
    activeAskId: null,
    investigation: null,  // { containerId, containerName } — 持续排障会话标记
    modalOpen: false,     // 全屏答案 Modal
    // —— PI 推理与工具调用 trace ——
    toolCalls: [],         // [{ toolCallId, toolName, args, argsSummary, status, startedAt, endedAt, durationMs, resultSize, partials }]
    thinkingText: '',      // 累积 thinking_delta;最终值在 ask 结束时保留
    traceExpanded: false,  // 折叠区开关;streaming 期间强制 true
    _hasThinkingSupport: false,
    _lastMatches: [],
    _off: [],
    init() {
      $store()._refs.analysisPanel = this;
      this._off.push(bus.on('search_results', ({ matches }) => {
        this._lastMatches = Array.isArray(matches) ? matches : [];
      }));
      this._off.push(bus.on('analysis_started', ({ askId, investigation }) => {
        this.activeAskId = askId;
        this.state = 'asking';
        this.answerText = '';
        this.errorMessage = '';
        this.additionalMessage = '';
        this.additionalStatus = '';
        this.additionalStatusIsError = false;
        this.acceptedInputs = [];
        this.toolCalls = [];
        this.thinkingText = '';
        this.traceExpanded = false;
        this._hasThinkingSupport = false;
        if (investigation) {
          this.investigation = {
            containerId: investigation.containerId,
            containerName: investigation.containerName,
          };
        }
      }));
      this._off.push(bus.on('analysis_meta', ({ askId, hasThinkingSupport }) => {
        if (askId !== this.activeAskId) return;
        this._hasThinkingSupport = !!hasThinkingSupport;
      }));
      this._off.push(bus.on('analysis_delta', ({ askId, delta }) => {
        if (askId !== this.activeAskId) return;
        this.state = 'streaming';
        this.answerText += delta;
      }));
      this._off.push(bus.on('analysis_thinking_delta', ({ askId, delta }) => {
        if (askId !== this.activeAskId) return;
        if (typeof delta !== 'string') return;
        this.thinkingText += delta;
        // 推理一出现就打开 trace,让用户看到模型在"工作"。
        this.traceExpanded = true;
      }));
      this._off.push(bus.on('analysis_tool_call', ({ askId, toolName, toolCallId, args, argsSummary }) => {
        if (askId !== this.activeAskId) return;
        this.toolCalls.push({
          toolCallId,
          toolName: toolName || '?',
          args: args ?? null,
          argsSummary: argsSummary || summarizeArgs(args, 160),
          status: 'running',
          startedAt: Date.now(),
          endedAt: null,
          durationMs: null,
          resultSize: null,
          partials: [],
        });
        this.traceExpanded = true;
      }));
      this._off.push(bus.on('analysis_tool_update', ({ askId, toolCallId, partialResult }) => {
        if (askId !== this.activeAskId) return;
        const t = this.toolCalls.find((x) => x.toolCallId === toolCallId);
        if (!t) return;
        if (Array.isArray(partialResult) || (partialResult && typeof partialResult === 'object')) {
          t.partials.push(partialResult);
        } else if (typeof partialResult === 'string') {
          t.partials.push(partialResult);
        } else {
          t.partials.push(String(partialResult));
        }
        // 只保留最近若干条,避免长跑 tool 占爆内存。
        if (t.partials.length > 50) t.partials.splice(0, t.partials.length - 50);
      }));
      this._off.push(bus.on('analysis_tool_result', ({ askId, toolCallId, toolName, isError, resultSize, durationMs }) => {
        if (askId !== this.activeAskId) return;
        const t = this.toolCalls.find((x) => x.toolCallId === toolCallId);
        if (!t) return;
        t.status = isError ? 'error' : 'ok';
        t.endedAt = Date.now();
        t.durationMs = Number.isFinite(durationMs) ? durationMs : (t.endedAt - t.startedAt);
        if (Number.isFinite(resultSize)) t.resultSize = resultSize;
        if (toolName) t.toolName = toolName;
      }));
      this._off.push(bus.on('analysis_message_end', () => {
        // 助手消息结束(可能是中间的 tool_use 段尾,也可能是最终答案结束)——这里
        // 不改变 stateLabel,留给 analysis_done 统一收尾。
      }));
      this._off.push(bus.on('analysis_done', ({ askId, fullText, partial }) => {
        if (askId !== this.activeAskId) return;
        if (partial && !this.answerText) this.answerText = fullText || '';
        this.state = partial ? 'aborted' : 'done';
        this.activeAskId = null;
        // ask 结束 → 自动折叠 trace,把视觉重点让给最终答案。
        this.traceExpanded = false;
        // investigation 标记在 ask 完成后保留,等 close_investigation 才清除。
      }));
      this._off.push(bus.on('analysis_error', ({ askId, message }) => {
        if (askId !== this.activeAskId) return;
        this.state = 'error';
        this.errorMessage = message;
        this.activeAskId = null;
        this.traceExpanded = false;
      }));
      this._off.push(bus.on('investigation_closed', ({ containerId }) => {
        if (this.investigation && this.investigation.containerId === containerId) {
          this.investigation = null;
        }
      }));
      this._off.push(bus.on('analysis_input_accepted', ({ askId, mode, message }) => {
        if (askId !== this.activeAskId) return;
        this.acceptedInputs.push({ mode, message });
        this.additionalMessage = '';
        this.additionalStatusIsError = false;
        this.additionalStatus = mode === 'steer'
          ? '已加入当前分析，将在本次工具调用后生效'
          : '已排队，将在当前分析结束后自动追问';
      }));
      this._off.push(bus.on('analysis_input_error', ({ askId, message }) => {
        if (askId !== this.activeAskId) return;
        this.additionalStatusIsError = true;
        this.additionalStatus = message || '补充信息发送失败';
      }));
    },
    destroy() { for (const off of this._off) try { off(); } catch (_) {} },
    get streaming() { return this.state === 'asking' || this.state === 'streaming'; },
    get stateLabel() {
      switch (this.state) {
        case 'idle': return 'ready';
        case 'asking': return 'connecting to PI…';
        case 'streaming': return 'streaming…';
        case 'done': return 'done';
        case 'aborted': return 'aborted';
        case 'error': return 'error';
        default: return '';
      }
    },
    get matchSummary() {
      const log = $store()._refs.logViewer;
      const selected = (log && Array.isArray(log.selectedLines)) ? log.selectedLines.length : 0;
      const hits = Array.isArray(this._lastMatches) ? this._lastMatches.length : 0;
      if (selected === 0 && hits === 0) return '点击日志行选择 / 搜索以填充证据';
      return `${hits} hit${hits === 1 ? '' : 's'} · ${selected} selected`;
    },
    /**
     * trace 折叠区头部一行概要,展示工具计数 / 状态 / 思考字符数。
     * 只显示有数据的部分,避免 ask 未开始时出现空 0/0/0。
     */
    traceSummary() {
      const tools = Array.isArray(this.toolCalls) ? this.toolCalls : [];
      if (tools.length === 0 && !this.thinkingText) return '';
      const ok = tools.filter((t) => t.status === 'ok').length;
      const bad = tools.filter((t) => t.status === 'error').length;
      const totalDur = tools.reduce((sum, t) => sum + (Number.isFinite(t.durationMs) ? t.durationMs : 0), 0);
      const durStr = totalDur > 0 ? `${(totalDur / 1000).toFixed(2)}s` : '';
      const parts = [];
      if (tools.length > 0) {
        parts.push(`${tools.length} 工具`);
        if (ok) parts.push(`${ok} ✓`);
        if (bad) parts.push(`${bad} ✗`);
        if (durStr) parts.push(durStr);
      }
      if (this.thinkingText) parts.push(`${this.thinkingText.length} 思考字符`);
      return parts.join(' · ');
    },
    get canAddInput() {
      return this.streaming && this.additionalMessage.trim().length > 0;
    },
    /**
     * 最终发给 PI 的 matches 列表。
     *
     * 合并策略:
     *   1) 搜索命中但仍被用户勾选 → 保留 search 结果带的 before/after 上下文
     *   2) 用户选中的 lineNo,但不在搜索命中里 → 裸行(无上下文)
     *   3) lineNo 去重,按行号升序
     */
    get effectiveMatches() {
      const log = $store()._refs.logViewer;
      const selectedLines = (log && Array.isArray(log.selectedLines)) ? log.selectedLines : [];
      const lines = (log && Array.isArray(log.lines)) ? log.lines : [];
      const last = Array.isArray(this._lastMatches) ? this._lastMatches : [];
      const selectedSet = new Set(selectedLines);
      const out = [];
      const used = new Set();
      for (const m of last) {
        if (!selectedSet.has(m.lineNo)) continue;
        out.push({ lineNo: m.lineNo, text: m.text, before: m.before || [], after: m.after || [] });
        used.add(m.lineNo);
      }
      for (const lineNo of selectedLines) {
        if (used.has(lineNo)) continue;
        const idx = lineNo - 1;
        if (idx < 0 || idx >= lines.length) continue;
        const text = lines[idx];
        if (typeof text !== 'string') continue;
        out.push({ lineNo, text, before: [], after: [] });
      }
      return out;
    },
    get canAsk() {
      return !this.streaming
        && this.userQuestion.trim().length > 0
        && this.effectiveMatches.length > 0;
    },
    askLLM() {
      if (!this.canAsk) return;
      const list = $store()._refs.containerList;
      const c = list && list.containers.find((x) => x.id === list.selectedId);
      const askId = 'ask-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      this.answerText = '';
      this.errorMessage = '';
      this.state = 'asking';
      this.activeAskId = askId;
      $store().send({
        type: 'ask_llm',
        payload: {
          askId,
          containerId: list?.selectedId || '',
          containerName: c?.name || 'unknown',
          matches: this.effectiveMatches,
          userQuestion: this.userQuestion.trim(),
          analysisMode: this.analysisMode,
        },
      });
    },
    addInput(mode) {
      if (!this.canAddInput || !this.activeAskId) return;
      const type = mode === 'followUp' ? 'follow_up_ask' : 'steer_ask';
      const sent = $store().send({
        type,
        payload: {
          askId: this.activeAskId,
          message: this.additionalMessage.trim(),
        },
      });
      this.additionalStatusIsError = !sent;
      this.additionalStatus = sent ? '正在提交…' : '连接不可用，补充信息未发送';
    },
    abortAsk() {
      if (!this.activeAskId) return;
      $store().send({ type: 'abort_ask', payload: { askId: this.activeAskId } });
    },
    closeInvestigation() {
      if (!this.investigation) return;
      $store().send({
        type: 'close_investigation',
        payload: { containerId: this.investigation.containerId },
      });
    },
    copyAnswer() {
      const text = this.answerText || '';
      if (!text) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => { /* ignore */ });
      }
    },
    clearAnswer() {
      this.answerText = '';
      this.modalOpen = false;
      this.state = 'idle';
      this.errorMessage = '';
      this.additionalMessage = '';
      this.additionalStatus = '';
      this.additionalStatusIsError = false;
      this.acceptedInputs = [];
      this.activeAskId = null;
      this.toolCalls = [];
      this.thinkingText = '';
      this.traceExpanded = false;
    },
  };
}

window.loader = loader;
window.containerList = containerList;
window.logViewer = logViewer;
window.analysisPanel = analysisPanel;
