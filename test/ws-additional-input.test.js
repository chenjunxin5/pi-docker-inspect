'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { attachWsRouter } = require('../src/ws-router');
const { InvestigationManager } = require('../src/investigation');

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('WebSocket 把 steer 和 followUp 转交给当前 PI 分析', async () => {
  const wss = new EventEmitter();
  const ws = new EventEmitter();
  const sent = [];
  const calls = [];
  const acquisitions = [];
  let finishPrompt;

  ws.OPEN = 1;
  ws.readyState = 1;
  ws.send = (message) => sent.push(JSON.parse(message));

  const client = {
    prompt() {
      return new Promise((resolve) => { finishPrompt = resolve; });
    },
    async steer(message) { calls.push(['steer', message]); },
    async followUp(message) { calls.push(['followUp', message]); },
    async abort() {},
  };
  const agentManager = {
    async acquire(options) { acquisitions.push(options); return client; },
    release() {},
  };

  attachWsRouter(wss, {
    docker: {},
    agentManager,
    investigations: new InvestigationManager({ agentManager }),
    projects: { mappings: {} },
  });
  wss.emit('connection', ws);

  ws.emit('message', JSON.stringify({
    type: 'ask_llm',
    payload: {
      askId: 'ask-1',
      containerId: 'c-test',
      containerName: 'test',
      userQuestion: '为什么失败？',
      analysisMode: 'deep',
    },
  }));
  await nextTurn();

  ws.emit('message', JSON.stringify({
    type: 'steer_ask',
    payload: { askId: 'ask-1', message: '重点看 14:30 之后' },
  }));
  ws.emit('message', JSON.stringify({
    type: 'follow_up_ask',
    payload: { askId: 'ask-1', message: '再检查发布配置' },
  }));
  await nextTurn();

  assert.deepEqual(calls, [
    ['steer', '重点看 14:30 之后'],
    ['followUp', '再检查发布配置'],
  ]);
  assert.deepEqual(acquisitions, [{ analysisMode: 'deep' }]);
  assert.equal(sent.filter((item) => item.type === 'analysis_input_accepted').length, 2);

  finishPrompt({ text: '完成', partial: false });
  await nextTurn();
});

test('追加信息不能串到另一个分析任务', async () => {
  const wss = new EventEmitter();
  const ws = new EventEmitter();
  const sent = [];

  ws.OPEN = 1;
  ws.readyState = 1;
  ws.send = (message) => sent.push(JSON.parse(message));

  attachWsRouter(wss, {
    docker: {},
    agentManager: {
      async acquire() { return { prompt() {}, steer() {}, followUp() {}, abort() {} }; },
      release() {},
    },
    investigations: new InvestigationManager({
      agentManager: {
        async acquire() { return { prompt() {}, steer() {}, followUp() {}, abort() {} }; },
        release() {},
      },
    }),
    projects: { mappings: {} },
  });
  wss.emit('connection', ws);
  ws.emit('message', JSON.stringify({
    type: 'steer_ask',
    payload: { askId: 'expired', message: '补充信息' },
  }));
  await nextTurn();

  const error = sent.find((item) => item.type === 'analysis_input_error');
  assert.equal(error.payload.askId, 'expired');
});
