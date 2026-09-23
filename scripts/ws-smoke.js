'use strict';

/**
 * Smoke test: connect to /ws, list containers, fetch logs, search, ask.
 * Run with: node scripts/ws-smoke.js
 */

const WebSocket = require('ws');

const HOST = process.env.HOST || 'localhost:3000';
const ws = new WebSocket(`ws://${HOST}/ws`);

let state = 'connecting';
let containerId = null;
let containerName = null;
const log = (...a) => console.log('[ws-test]', ...a);

ws.on('open', () => {
  state = 'open';
  log('connected, listing containers');
  ws.send(JSON.stringify({ type: 'list_containers' }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  log('RECV', msg.type, summary(msg.payload));
  switch (msg.type) {
    case 'hello':
      break;
    case 'containers': {
      // Pick errgen (the one with periodic ERROR lines).
      const c = msg.payload.containers.find((x) => x.name === 'errgen')
        || msg.payload.containers[0];
      if (!c) { log('no containers'); return process.exit(1); }
      containerId = c.id;
      containerName = c.name;
      log('selected', containerName, containerId.slice(0, 12));
      ws.send(JSON.stringify({ type: 'fetch_logs', payload: { containerId, tail: 50 } }));
      break;
    }
    case 'logs': {
      log('got', msg.payload.lines.length, 'log lines');
      ws.send(JSON.stringify({
        type: 'search_logs',
        payload: {
          containerId,
          query: 'ERROR',
          mode: 'substring',
          contextBefore: 1,
          contextAfter: 1,
        },
      }));
      break;
    }
    case 'search_results': {
      log('search', msg.payload.matches.length, 'matches, truncated=', msg.payload.truncated);
      if (msg.payload.matches.length === 0) {
        log('no matches, asking without search');
      }
      ws.send(JSON.stringify({
        type: 'ask_llm',
        payload: {
          askId: 'test-1',
          containerId,
          containerName,
          matches: msg.payload.matches.length
            ? msg.payload.matches.slice(0, 5)
            : [{ lineNo: 1, text: msg.payload.lines?.[0] || '(empty buffer)', before: [], after: [] }],
          userQuestion: 'Identify the cadence and likely root cause from these matches.',
        },
      }));
      break;
    }
    case 'analysis_started':
      log('analysis started for', msg.payload.askId);
      break;
    case 'analysis_meta':
      log('analysis_meta', msg.payload);
      break;
    case 'analysis_delta':
      process.stdout.write(msg.payload.delta);
      break;
    case 'analysis_thinking_delta':
      log('thinking Δ', msg.payload.delta.length, 'chars');
      break;
    case 'analysis_tool_call':
      log('🔧', msg.payload.toolName, msg.payload.argsSummary);
      break;
    case 'analysis_tool_update':
      log('🔧 ·', msg.payload.toolName, 'partial updated');
      break;
    case 'analysis_tool_result':
      log('  ↳', msg.payload.toolName,
        msg.isError ? '✗' : 'ok',
        msg.payload.resultSize + 'b', msg.payload.durationMs + 'ms');
      break;
    case 'analysis_message_end':
      log('analysis_message_end');
      break;
    case 'analysis_done':
      log('analysis_done, fullText=', msg.payload.fullText.length, 'bytes, partial=', msg.payload.partial);
      log('DONE — closing in 1s');
      setTimeout(() => process.exit(0), 1000);
      break;
    case 'analysis_error':
      log('analysis_error', msg.payload.message);
      process.exit(1);
      break;
    case 'error':
      log('ERROR', msg.payload);
      break;
  }
});

ws.on('error', (err) => log('ws error', err.message));
ws.on('close', () => log('ws closed'));

setTimeout(() => { log('timeout — exiting'); process.exit(2); }, 60_000);

function summary(p) {
  if (!p) return '';
  if (p.containers) return `[containers=${p.containers.length}]`;
  if (p.lines) return `[lines=${p.lines.length}]`;
  if (p.matches) return `[matches=${p.matches.length}]`;
  if (p.delta !== undefined) return `[delta len=${p.delta.length}]`;
  if (p.toolName) return `[tool=${p.toolName} args=${p.argsSummary || ''}]`;
  if (p.fullText !== undefined) return `[fullText len=${p.fullText.length}]`;
  if (p.message) return `[msg="${String(p.message).slice(0, 80)}"]`;
  return '';
}