'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { DockerClient } = require('./src/docker');
const { PiAgentManager, DEFAULT_SYSTEM_PROMPT } = require('./src/pi-agent');
const { InvestigationManager } = require('./src/investigation');
const { createHttpRouter } = require('./src/http-routes');
const { attachWsRouter } = require('./src/ws-router');
const { loadProjects } = require('./src/projects');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';

// PI 从 ~/.pi/agent/{auth,models}.json 加载配置，并用下面两个值显式选择模型。
// setup-pi-auth.sh 会根据它们准备 auth.json 和 models.json。
const PI_PROVIDER = process.env.PI_PROVIDER || 'minimax';
const PI_MODEL = process.env.PI_MODEL || 'MiniMax-M2.7';
const PI_SUPPORTS_REASONING = process.env.PI_SUPPORTS_REASONING !== '0';
const PI_SYSTEM_PROMPT = process.env.PI_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;

const docker = new DockerClient({ socketPath: SOCKET_PATH });
const agentManager = new PiAgentManager({
  docker,
  systemPrompt: PI_SYSTEM_PROMPT,
  provider: PI_PROVIDER,
  modelId: PI_MODEL,
  supportsReasoning: PI_SUPPORTS_REASONING,
});

// 持续排障会话:按 containerId 把多个 ask 粘到同一个 PI 会话上。
const investigations = new InvestigationManager({ agentManager });

// Container-name → source-repo mapping. Optional; missing file is fine.
const projects = loadProjects(__dirname);

const app = express();
app.use('/api', createHttpRouter({ docker }));
app.use(express.static(path.join(__dirname, 'public')));

// Root → index.html (express.static handles it).

const http_srv = http.createServer(app);
const wss = new WebSocketServer({ server: http_srv, path: '/ws' });
attachWsRouter(wss, { docker, agentManager, projects, investigations });

// Heartbeat: ping every 30s, terminate if no pong within 60s.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (_) { /* ignore */ }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) { /* ignore */ }
  }
}, 30_000);
heartbeat.unref?.();

http_srv.listen(PORT, () => {
  console.log(`docker-logs-agent listening on http://localhost:${PORT}`);
  console.log(`  docker socket : ${SOCKET_PATH}`);
  console.log(`  pi mode       : library (in-process AgentSession)`);
  console.log(`  pi provider   : ${PI_PROVIDER}`);
  console.log(`  pi model      : ${PI_MODEL}`);
  console.log(`  pi reasoning  : ${PI_SUPPORTS_REASONING ? 'enabled' : 'disabled'}`);

  const agentDir = path.join(require('node:os').homedir(), '.pi', 'agent');
  const authFile = path.join(agentDir, 'auth.json');
  const modelsFile = path.join(agentDir, 'models.json');
  const fs = require('node:fs');

  let authHint = 'missing';
  let baseUrlHint = 'missing';
  try {
    const data = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    const entry = data && data[PI_PROVIDER];
    authHint = entry && entry.key ? `present (${PI_PROVIDER})` : `no '${PI_PROVIDER}' entry`;
  } catch (_) { /* missing or malformed */ }
  try {
    const data = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
    const p = data.providers && data.providers[PI_PROVIDER];
    baseUrlHint = p && p.baseUrl ? p.baseUrl : `no '${PI_PROVIDER}' provider`;
  } catch (_) { /* missing or malformed */ }
  console.log(`  pi base url   : ${baseUrlHint}  (from ${modelsFile})`);
  console.log(`  pi auth.json  : ${authFile}  [${authHint}]`);

  const needsSetup = authHint !== `present (${PI_PROVIDER})` || baseUrlHint === 'missing'
    || baseUrlHint === `no '${PI_PROVIDER}' provider`;
  if (needsSetup) {
    console.warn(`  ⚠ PI config incomplete for '${PI_PROVIDER}' — Ask LLM will fail.`);
    console.warn(`     run:  ./scripts/setup-pi-auth.sh`);
  }

  // Project mappings → source-repo hints. Silent if no projects.json.
  const names = Object.keys(projects.mappings || {});
  if (names.length === 0) {
    console.log(`  projects.json : ${projects._configPath}  [no mappings]`);
  } else {
    console.log(`  projects.json : ${projects._configPath}  [${names.length} mapping${names.length === 1 ? '' : 's'}: ${names.join(', ')}]`);
  }
});

function shutdown(reason) {
  console.log(`\n[shutdown] ${reason}`);
  clearInterval(heartbeat);
  // 先关闭 WebSocket，让处理器释放正在使用的 PI 会话。
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server shutting down'); } catch (_) { /* ignore */ }
  }
  try { wss.close(); } catch (_) { /* ignore */ }
  investigations.shutdown();
  agentManager.shutdown();
  http_srv.close(() => process.exit(0));
  // Hard kill after 3s.
  setTimeout(() => process.exit(1), 3000).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandled-rejection]', err);
});
