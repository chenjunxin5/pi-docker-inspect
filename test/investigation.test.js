'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { InvestigationManager, DEFAULT_IDLE_MS } = require('../src/investigation');

/** 假 agentManager:acquire 返回带 kill() 的占位 agent,release 会真正调用 kill。 */
function fakeAgentManager() {
  const agents = new Set();
  return {
    agents,
    async acquire() {
      const agent = { id: Math.random(), killed: false, kill() { this.killed = true; } };
      agents.add(agent);
      return agent;
    },
    release(agent) {
      agents.delete(agent);
      agent.kill();
    },
  };
}

test('首次 acquire 返回 reused=false 的新会话', async () => {
  const am = fakeAgentManager();
  const inv = new InvestigationManager({ agentManager: am });
  const r = await inv.acquire({ containerId: 'c1', analysisMode: 'quick' });
  assert.equal(r.reused, false);
  assert.equal(r.busy, undefined);
  assert.ok(r.client);
  assert.equal(am.agents.size, 1);
});

test('同一 container 在空闲窗口内再次 acquire 复用同一会话', async () => {
  const am = fakeAgentManager();
  const inv = new InvestigationManager({ agentManager: am });
  const a = await inv.acquire({ containerId: 'c1', analysisMode: 'quick' });
  const b = await inv.acquire({ containerId: 'c1', analysisMode: 'quick' });
  assert.equal(b.reused, true);
  assert.equal(a.client, b.client);
  assert.equal(am.agents.size, 1);
});

test('不同 container 各自独立会话', async () => {
  const am = fakeAgentManager();
  const inv = new InvestigationManager({ agentManager: am });
  const a = await inv.acquire({ containerId: 'c1' });
  const b = await inv.acquire({ containerId: 'c2' });
  assert.notEqual(a.client, b.client);
  assert.equal(am.agents.size, 2);
});

test('acquire 必须传 containerId', async () => {
  const inv = new InvestigationManager({ agentManager: fakeAgentManager() });
  await assert.rejects(() => inv.acquire({ analysisMode: 'quick' }), /containerId is required/);
});

test('busy 中的会话再次 acquire 返回 busy', async () => {
  const am = fakeAgentManager();
  const inv = new InvestigationManager({ agentManager: am });
  await inv.acquire({ containerId: 'c1' });
  inv.markBusy('c1');
  const r = await inv.acquire({ containerId: 'c1' });
  assert.equal(r.busy, true);
});

test('markIdle 后可以再次 acquire 拿到同一会话', async () => {
  const am = fakeAgentManager();
  const inv = new InvestigationManager({ agentManager: am });
  const first = await inv.acquire({ containerId: 'c1' });
  inv.markBusy('c1');
  await inv.acquire({ containerId: 'c1' }); // busy
  inv.markIdle('c1');
  const second = await inv.acquire({ containerId: 'c1' });
  assert.equal(second.reused, true);
  assert.equal(first.client, second.client);
});

test('超过 idleMs 后再 acquire 释放旧会话、创建新会话', async () => {
  const am = fakeAgentManager();
  const inv = new InvestigationManager({ agentManager: am, idleMs: 20 });
  const first = await inv.acquire({ containerId: 'c1' });
  await new Promise((r) => setTimeout(r, 30));
  const second = await inv.acquire({ containerId: 'c1' });
  assert.equal(second.reused, false);
  assert.notEqual(first.client, second.client);
  assert.equal(first.client.killed, true);
  assert.equal(am.agents.size, 1);
});

test('close 立即释放会话并清掉条目', async () => {
  const am = fakeAgentManager();
  const inv = new InvestigationManager({ agentManager: am });
  const r = await inv.acquire({ containerId: 'c1' });
  const released = inv.close('c1');
  assert.equal(released, true);
  assert.equal(r.client.killed, true);
  assert.equal(am.agents.size, 0);
  // 第二次 close 返回 false,不再有副作用。
  assert.equal(inv.close('c1'), false);
  assert.equal(am.agents.size, 0);
});

test('close 不存在的 containerId 返回 false,不抛错', () => {
  const inv = new InvestigationManager({ agentManager: fakeAgentManager() });
  assert.equal(inv.close('nonexistent'), false);
});

test('shutdown 释放全部会话', async () => {
  const am = fakeAgentManager();
  const inv = new InvestigationManager({ agentManager: am });
  const a = await inv.acquire({ containerId: 'c1' });
  const b = await inv.acquire({ containerId: 'c2' });
  inv.shutdown();
  assert.equal(a.client.killed, true);
  assert.equal(b.client.killed, true);
  assert.equal(am.agents.size, 0);
});

test('默认空闲时间是 30 分钟', () => {
  assert.equal(DEFAULT_IDLE_MS, 30 * 60 * 1000);
});
