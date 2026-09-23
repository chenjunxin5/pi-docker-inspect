'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { attachWsRouter } = require('../src/ws-router');
const { InvestigationManager } = require('../src/investigation');

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeFixture() {
  const wss = new EventEmitter();
  const ws = new EventEmitter();
  const sent = [];
  // 用 mutable holder 暴露给测试:避免解构时拿到值的快照。
  const holder = { resolve: null };

  ws.OPEN = 1;
  ws.readyState = 1;
  ws.send = (message) => sent.push(JSON.parse(message));

  let captured = null;
  const client = {
    prompt(_msg, callbacks) {
      captured = callbacks;
      return new Promise((resolve) => { holder.resolve = resolve; });
    },
    async steer() {},
    async followUp() {},
    async abort() {},
  };
  const agentManager = {
    async acquire() { return client; },
    release() {},
  };

  attachWsRouter(wss, {
    docker: {},
    agentManager,
    investigations: new InvestigationManager({ agentManager }),
    projects: { mappings: {} },
  });
  wss.emit('connection', ws);

  return {
    ws,
    sent,
    fire: (cb) => captured[cb].bind(captured),
    finishPrompt: (result) => holder.resolve(result),
  };
}

test('PI 推理与工具调用默认实时回传浏览器', async () => {
  const { ws, sent, fire } = makeFixture();

  ws.emit('message', JSON.stringify({
    type: 'ask_llm',
    payload: {
      askId: 'ask-trace',
      containerId: 'c-trace',
      containerName: 'demo',
      userQuestion: '查一下最近的报错',
      analysisMode: 'deep',
    },
  }));
  await nextTurn();

  // analysis_started + analysis_meta 应该先到达。
  const started = sent.find((s) => s.type === 'analysis_started');
  assert.ok(started, '应发出 analysis_started');
  const meta = sent.find((s) => s.type === 'analysis_meta');
  assert.ok(meta, '应发出 analysis_meta');
  assert.equal(meta.payload.askId, 'ask-trace');
  assert.equal(meta.payload.hasThinkingSupport, true);

  // 模拟 PI 内部事件依次到达。
  fire('onThinkingDelta')('容器启动失败: ');
  fire('onThinkingDelta')('可能缺少 config.yaml');
  fire('onToolStart')({
    toolCallId: 'tc-1', toolName: 'docker_get_logs', args: { container: 'demo', tail: 200 },
  });
  fire('onToolUpdate')({ toolCallId: 'tc-1', partialResult: 'partial-1' });
  fire('onToolUpdate')({ toolCallId: 'tc-1', partialResult: 'partial-2' });
  fire('onToolEnd')({
    toolCallId: 'tc-1', toolName: 'docker_get_logs',
    isError: false, resultSize: 1024, durationMs: 350,
  });
  fire('onToolStart')({
    toolCallId: 'tc-2', toolName: 'grep', args: { pattern: 'ERROR', path: '/etc/app' },
  });
  fire('onToolEnd')({
    toolCallId: 'tc-2', toolName: 'grep',
    isError: true, resultSize: 0, durationMs: 120,
  });
  fire('onDelta')('根因是配置文件缺失');
  await nextTurn();

  const types = sent.map((s) => s.type);
  // 工具事件应当无条件发出 (不再受 PI_BROWSER_TRACE 开关控制)。
  assert.ok(types.includes('analysis_tool_call'), 'analysis_tool_call 应发出');
  assert.ok(types.includes('analysis_tool_update'), 'analysis_tool_update 应发出');
  assert.ok(types.includes('analysis_tool_result'), 'analysis_tool_result 应发出');
  assert.ok(types.includes('analysis_thinking_delta'), 'analysis_thinking_delta 应发出');

  // 两次 thinking_delta 的 delta 拼接顺序与原文一致。
  const thinkFrames = sent.filter((s) => s.type === 'analysis_thinking_delta');
  assert.deepEqual(
    thinkFrames.map((s) => s.payload.delta),
    ['容器启动失败: ', '可能缺少 config.yaml'],
  );

  // tool_call 应同时带 args (完整) 和 argsSummary (服务端摘要)。
  const firstCall = sent.filter((s) => s.type === 'analysis_tool_call').map((s) => s.payload)[0];
  assert.equal(firstCall.toolCallId, 'tc-1');
  assert.equal(firstCall.toolName, 'docker_get_logs');
  assert.deepEqual(firstCall.args, { container: 'demo', tail: 200 });
  assert.ok(typeof firstCall.argsSummary === 'string' && firstCall.argsSummary.length > 0,
    `argsSummary 应为非空字符串,得到 ${JSON.stringify(firstCall.argsSummary)}`);

  // tool_update 透传 partialResult。
  const updates = sent.filter((s) => s.type === 'analysis_tool_update');
  assert.equal(updates.length, 2);
  assert.equal(updates[0].payload.partialResult, 'partial-1');
  assert.equal(updates[1].payload.partialResult, 'partial-2');

  // tool_result 带 isError + durationMs + resultSize。
  const results = sent.filter((s) => s.type === 'analysis_tool_result');
  assert.equal(results.length, 2);
  const okResult = results.find((r) => r.payload.toolCallId === 'tc-1');
  const errResult = results.find((r) => r.payload.toolCallId === 'tc-2');
  assert.equal(okResult.payload.isError, false);
  assert.equal(okResult.payload.durationMs, 350);
  assert.equal(okResult.payload.resultSize, 1024);
  assert.equal(errResult.payload.isError, true);
});

test('同一连接串行两次 ask:每次都重新发出 analysis_started / _meta / _tool_call', async () => {
  // 确认多轮 ask 之间状态被正确隔离;不残留上一轮的 toolCalls 或 meta 标记。
  const { ws, sent, fire, finishPrompt } = makeFixture();

  ws.emit('message', JSON.stringify({
    type: 'ask_llm',
    payload: {
      askId: 'ask-1', containerId: 'c-1', containerName: 'a',
      userQuestion: '?', analysisMode: 'quick',
    },
  }));
  await nextTurn();
  fire('onToolStart')({ toolCallId: 't1', toolName: 'docker_get_logs', args: { container: 'a' } });
  finishPrompt({ text: 'done', partial: false });
  await nextTurn();

  ws.emit('message', JSON.stringify({
    type: 'ask_llm',
    payload: {
      askId: 'ask-2', containerId: 'c-2', containerName: 'b',
      userQuestion: '?', analysisMode: 'quick',
    },
  }));
  await nextTurn();
  fire('onToolStart')({ toolCallId: 't2', toolName: 'docker_search_logs', args: { container: 'b' } });
  await nextTurn();

  const startedCount = sent.filter((s) => s.type === 'analysis_started').length;
  const metaCount = sent.filter((s) => s.type === 'analysis_meta').length;
  assert.equal(startedCount, 2, '两轮 ask 都应发出 analysis_started');
  assert.equal(metaCount, 2, '两轮 ask 都应发出 analysis_meta');

  // 第二轮的工具调用应只包含 t2,不应混入第一轮的 t1。
  const secondCall = sent.filter((s) => s.type === 'analysis_tool_call'
    && s.payload.askId === 'ask-2');
  assert.equal(secondCall.length, 1);
  assert.equal(secondCall[0].payload.toolCallId, 't2');
});