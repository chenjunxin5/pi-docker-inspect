'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createDockerTools,
  DOCKER_TOOL_NAMES,
  PI_READ_ONLY_TOOL_NAMES,
} = require('../src/pi-docker-tools');
const { buildBrowserPrompt } = require('../src/ws-router');

function createFakeDocker() {
  return {
    async listRunning() {
      return [{ id: 'abc', name: 'api', image: 'demo:latest', status: 'Up 1 minute' }];
    },
    async fetchLogs() {
      return ['started', 'ERROR database unavailable', 'retrying'];
    },
    async getStats() {
      return { cpuPerc: 1.5, memUsage: 100, memLimit: 1000, netRx: 10, netTx: 20 };
    },
  };
}

test('只注册四个只读 Docker 工具', () => {
  const tools = createDockerTools(createFakeDocker());
  assert.deepEqual(tools.map((tool) => tool.name), DOCKER_TOOL_NAMES);
  assert.equal(PI_READ_ONLY_TOOL_NAMES.includes('bash'), false);
  assert.equal(PI_READ_ONLY_TOOL_NAMES.includes('edit'), false);
  assert.equal(PI_READ_ONLY_TOOL_NAMES.includes('write'), false);
});

test('日志工具生成可引用的行号', async () => {
  const tool = createDockerTools(createFakeDocker())
    .find((item) => item.name === 'docker_get_logs');
  const result = await tool.execute('call-1', { container: 'api', tail: 20 });

  assert.match(result.content[0].text, /\[L2\] ERROR database unavailable/);
  assert.equal(result.details.returnedLines, 3);
});

test('搜索工具复用项目的日志搜索逻辑', async () => {
  const tool = createDockerTools(createFakeDocker())
    .find((item) => item.name === 'docker_search_logs');
  const result = await tool.execute('call-2', {
    container: 'api',
    query: 'ERROR',
    mode: 'substring',
  });
  const data = JSON.parse(result.content[0].text);

  assert.equal(data.matches.length, 1);
  assert.equal(data.matches[0].lineNo, 2);
  assert.equal(data.matches[0].text, 'ERROR database unavailable');
});

test('浏览器提示词只引导 PI 使用结构化工具', () => {
  const prompt = buildBrowserPrompt({
    containerName: 'api',
    containerId: 'abc',
    matches: [],
    userQuestion: '为什么失败？',
    sourceRepo: null,
  });

  assert.match(prompt, /\[skill-name\] docker-logs/);
  assert.doesNotMatch(prompt, /skill-scripts|\.sh\b/);
});

test('浏览器提示词会把命中行的前后上下文一起发给 PI', () => {
  const prompt = buildBrowserPrompt({
    containerName: 'api',
    containerId: 'abc',
    matches: [
      // 命中行 L3，前后各 2 行（src/search.js 的约定：before/after 由近到远）。
      { lineNo: 3, text: 'ERROR database unavailable', before: ['started', 'connecting'], after: ['retrying in 3s', 'retrying in 6s'] },
    ],
    userQuestion: '为什么失败？',
    sourceRepo: null,
  });

  // 命中行用 >>...<< 包住，上下文行仅靠行号标识。
  assert.match(prompt, />>\[L3\] ERROR database unavailable<</);
  // before[0]='started' 是 lineNo-1（L2），before[1]='connecting' 是 lineNo-2（L1）。
  assert.match(prompt, /\[L1\] connecting/);
  assert.match(prompt, /\[L2\] started/);
  assert.match(prompt, /\[L4\] retrying in 3s/);
  assert.match(prompt, /\[L5\] retrying in 6s/);
});

test('多 match 重叠时同一物理行只出现一次，且命中行优先于上下文行', () => {
  const prompt = buildBrowserPrompt({
    containerName: 'api',
    containerId: 'abc',
    matches: [
      // L5 是 match A 的命中行；L4 同时是 A 的命中行的上下文。
      { lineNo: 5, text: 'panic', before: ['connected', 'login ok'], after: [] },
      { lineNo: 4, text: 'login ok', before: [], after: [] },
    ],
    userQuestion: '为什么 panic？',
    sourceRepo: null,
  });

  // L4 同时是 match B 的命中行和 match A 的上下文行 —— 必须标记为命中。
  const lines = prompt.split('\n').filter((l) => /\[L\d+\]/.test(l));
  const l4 = lines.find((l) => l.includes('[L4]'));
  assert.match(l4, /^  >>\[L4\] login ok<</);

  // 同一行只出现一次。
  assert.equal(lines.filter((l) => l.includes('[L4]')).length, 1);
});

test('matches 为空时不输出 [browser-highlighted-matches] 段落', () => {
  const prompt = buildBrowserPrompt({
    containerName: 'api',
    containerId: 'abc',
    matches: [],
    userQuestion: '为什么失败？',
    sourceRepo: null,
  });

  assert.doesNotMatch(prompt, /browser-highlighted-matches/);
});

test('手动选中的行（无 before/after）能被正常发给 PI', () => {
  // 模拟前端 effectiveMatches 输出：手动勾选的行 before/after 为空数组。
  const prompt = buildBrowserPrompt({
    containerName: 'api',
    containerId: 'abc',
    matches: [
      { lineNo: 5, text: 'user-picked line', before: [], after: [] },
      { lineNo: 8, text: 'another pick', before: [], after: [] },
    ],
    userQuestion: '为什么异常？',
    sourceRepo: null,
  });

  assert.match(prompt, />>\[L5\] user-picked line<</);
  assert.match(prompt, />>\[L8\] another pick<</);
  // 没有上下文行,不应出现无 >> 标记的行号。
  const lineLines = prompt.split('\n').filter((l) => /\[L\d+\]/.test(l));
  assert.equal(lineLines.length, 2);
});

test('手动选中行与搜索命中行混合时,命中行仍带上下文', () => {
  // 搜索命中 L10 带前后文；用户额外手动选了 L20。
  const prompt = buildBrowserPrompt({
    containerName: 'api',
    containerId: 'abc',
    matches: [
      { lineNo: 10, text: 'ERROR', before: ['started', 'connecting'], after: ['retrying'] },
      { lineNo: 20, text: 'manual pick', before: [], after: [] },
    ],
    userQuestion: '为什么失败？',
    sourceRepo: null,
  });

  // L10 命中行带 >>...<<
  assert.match(prompt, />>\[L10\] ERROR<</);
  // L10 的上下文 L9/L11 也输出
  assert.match(prompt, /\[L9\] started/);
  assert.match(prompt, /\[L11\] retrying/);
  // L20 是手动选的(裸行),没有上下文行
  assert.match(prompt, />>\[L20\] manual pick<</);
  // L20 周围不应出现 [L19] / [L21]
  assert.doesNotMatch(prompt, /\[L19\]/);
  assert.doesNotMatch(prompt, /\[L21\]/);
});
