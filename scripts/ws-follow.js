'use strict';

/**
 * Smoke test for follow mode: select a container, start follow, count lines.
 */
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000/ws');
let containerId = null;
let lineCount = 0;
let startedAt = null;

ws.on('open', () => {
  console.log('[follow-test] connected');
  ws.send(JSON.stringify({ type: 'list_containers' }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'containers') {
    const c = msg.payload.containers.find((x) => x.name === 'loggen');
    containerId = c.id;
    ws.send(JSON.stringify({ type: 'start_follow', payload: { containerId } }));
  } else if (msg.type === 'follow_started') {
    console.log('[follow-test] follow_started, waiting 5s for new lines');
    startedAt = Date.now();
    setTimeout(() => {
      console.log(`[follow-test] received ${lineCount} lines in 5s`);
      ws.send(JSON.stringify({ type: 'stop_follow', payload: { containerId } }));
      setTimeout(() => process.exit(0), 200);
    }, 5000);
  } else if (msg.type === 'log_line') {
    lineCount += 1;
  } else if (msg.type === 'follow_stopped') {
    console.log('[follow-test] follow_stopped');
  }
});

ws.on('error', (err) => console.error('[follow-test]', err.message));
setTimeout(() => { console.error('[follow-test] TIMEOUT'); process.exit(2); }, 15_000);