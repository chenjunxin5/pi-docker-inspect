'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PiAgent, ANALYSIS_MODES, configureSessionModel, buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } = require('../src/pi-agent');

function createRunningAgent() {
  const calls = [];
  const agent = new PiAgent({ docker: {} });
  agent.session = {
    async steer(message) { calls.push(['steer', message]); },
    async followUp(message) { calls.push(['followUp', message]); },
  };
  agent.currentRun = {};
  return { agent, calls };
}

test('steer 把信息交给正在运行的 PI 会话', async () => {
  const { agent, calls } = createRunningAgent();

  await agent.steer('重点查看 14:30 之后的日志');

  assert.deepEqual(calls, [['steer', '重点查看 14:30 之后的日志']]);
});

test('followUp 把问题排到当前分析之后', async () => {
  const { agent, calls } = createRunningAgent();

  await agent.followUp('再检查本次发布的配置变更');

  assert.deepEqual(calls, [['followUp', '再检查本次发布的配置变更']]);
});

test('分析结束后拒绝追加信息', async () => {
  const { agent } = createRunningAgent();
  agent.currentRun = null;

  await assert.rejects(() => agent.steer('太晚了'), /not processing/);
  await assert.rejects(() => agent.followUp('太晚了'), /not processing/);
});

test('快速和深度模式映射到 PI 思考等级', () => {
  assert.equal(ANALYSIS_MODES.quick.thinkingLevel, 'low');
  assert.equal(ANALYSIS_MODES.deep.thinkingLevel, 'high');
});

test('quick 模式提示词鼓励直接回答并避免不必要的工具调用', () => {
  const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, 'quick');
  assert.ok(prompt.startsWith(DEFAULT_SYSTEM_PROMPT));
  assert.match(prompt, /快速分析模式/);
  assert.match(prompt, /直接作答/);
  assert.match(prompt, /避免不必要的工具调用/);
  assert.doesNotMatch(prompt, /深度分析模式/);
});

test('deep 模式提示词要求代码+日志双证据并禁止凭空捏造', () => {
  const prompt = buildSystemPrompt(DEFAULT_SYSTEM_PROMPT, 'deep');
  assert.ok(prompt.startsWith(DEFAULT_SYSTEM_PROMPT));
  assert.match(prompt, /深度分析模式/);
  assert.match(prompt, /多次调用/);
  assert.match(prompt, /交叉验证/);
  // 强调代码与日志双证据
  assert.match(prompt, /代码/);
  assert.match(prompt, /日志/);
  // 每条结论必须可追溯
  assert.match(prompt, /证据来源/);
  // 明确禁止凭空捏造 / 猜想填补空缺
  assert.match(prompt, /不得用.{0,8}填补空缺|不得用猜测/);
  assert.doesNotMatch(prompt, /快速分析模式/);
});

test('显式设置 PI 模型和思考等级', async () => {
  const model = { provider: 'demo', id: 'model-1', reasoning: true };
  const calls = [];
  const modelRuntime = {
    getModel(provider, modelId) {
      calls.push(['getModel', provider, modelId]);
      return model;
    },
  };
  const session = {
    async setModel(value) { calls.push(['setModel', value]); },
    setThinkingLevel(value) {
      this.thinkingLevel = value;
      calls.push(['setThinkingLevel', value]);
    },
  };

  await configureSessionModel({
    session, modelRuntime, provider: 'demo', modelId: 'model-1', thinkingLevel: 'high',
  });

  assert.deepEqual(calls, [
    ['getModel', 'demo', 'model-1'],
    ['setModel', model],
    ['setThinkingLevel', 'high'],
  ]);
});

test('模型不支持所选思考等级时明确报错', async () => {
  const session = {
    thinkingLevel: 'off',
    async setModel() {},
    setThinkingLevel() {},
  };

  await assert.rejects(() => configureSessionModel({
    session,
    modelRuntime: { getModel: () => ({ id: 'plain-model' }) },
    provider: 'demo',
    modelId: 'plain-model',
    thinkingLevel: 'high',
    supportsReasoning: false,
  }), /does not support thinkingLevel=high/);
});

test('仅在内存中补全自定义模型的推理能力声明', async () => {
  const registeredModel = { provider: 'demo', id: 'model-1', reasoning: false };
  let selectedModel;
  const session = {
    thinkingLevel: 'off',
    async setModel(model) { selectedModel = model; },
    setThinkingLevel(level) { this.thinkingLevel = level; },
  };

  await configureSessionModel({
    session,
    modelRuntime: { getModel: () => registeredModel },
    provider: 'demo',
    modelId: 'model-1',
    thinkingLevel: 'low',
    supportsReasoning: true,
  });

  assert.equal(registeredModel.reasoning, false);
  assert.equal(selectedModel.reasoning, true);
  assert.notEqual(selectedModel, registeredModel);
});
