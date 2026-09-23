'use strict';

/**
 * PI 接入层
 *
 * 这个文件只做四件事：
 * 1. 创建 PI 会话；
 * 2. 注册工具安全守卫；
 * 3. 把 PI 事件转换成页面需要的少量事件；
 * 4. 在请求结束后释放会话。
 *
 * PI 的 Agent 循环、模型调用、工具执行和自动重试都由框架负责，
 * 项目不再重复实现队列、Promise 结算或重试状态机。
 */

const path = require('node:path');
const os = require('node:os');
const { createDockerTools, PI_READ_ONLY_TOOL_NAMES } = require('./pi-docker-tools');

// PI 只提供 ESM 版本；项目是 CommonJS，因此使用动态导入。
// 只在首次创建会话时加载，之后所有会话共用同一个模型运行时。
let piLibPromise;
let modelRuntimePromise;

function loadPi() {
  if (!piLibPromise) piLibPromise = import('@earendil-works/pi-coding-agent');
  return piLibPromise;
}

function loadModelRuntime() {
  if (!modelRuntimePromise) {
    modelRuntimePromise = loadPi().then((lib) => lib.ModelRuntime.create());
  }
  return modelRuntimePromise;
}

const DEFAULT_SYSTEM_PROMPT = [
  '你是协助开发人员调试运行中 Docker 容器的高级 SRE 工程师。',
  '用户已经用关键词/正则过滤了容器日志，并把匹配行连同问题一起提供给你。',
  '',
  '规则：',
  '- 引用证据时使用形如 [L42] 的具体行号。',
  '- 区分根因与相关性。',
  '- 优先给出最小、最可测试的假设。',
  '- 如果匹配行不足，明确指出并列出还需要哪些日志或命令；不要编造数据。',
  '- 保持简洁：使用短句要点；不要开场白或结束寒暄。',
  '- 仅输出纯文本。',
].join('\n');

/** 页面上的两个分析模式只映射 PI 的思考等级，不引入第二套执行流程。 */
const ANALYSIS_MODES = Object.freeze({
  quick: Object.freeze({ thinkingLevel: 'low' }),
  deep: Object.freeze({ thinkingLevel: 'high' }),
});

/**
 * 在基础系统提示词上叠加分析模式专属指令。
 *
 * PI 的 thinkingLevel 只调整模型"多想多少"，并不改变 Agent 是否调用工具。
 * 因此需要用提示词显式拉开两个模式的行为差异：
 * - quick：尽量基于用户已经过滤的日志直接回答，只在必要时才读取更多日志；
 * - deep：要求结合"代码 + 日志"双证据分析，每条结论都要可追溯，禁止凭空捏造或猜想。
 *
 * 拼接结果仍以"仅输出纯文本"收尾，避免子句被中间插入破坏。
 */
function buildSystemPrompt(basePrompt, analysisMode) {
  const tail = analysisMode === 'deep'
    ? [
        '',
        '深度分析模式：',
        '- 必须结合"代码"与"日志"两类证据：日志说明"发生了什么"，代码说明"为什么会发生"。',
        '- 可多次调用只读工具（docker_get_logs / docker_search_logs / docker_list_containers /',
        '  docker_get_stats，以及 read / grep / find / ls 读取源码）收集证据后再下结论；',
        '  不要在证据不足时急于作答。',
        '- 每条结论都必须给出可追溯的证据来源：行号（如 [L42]）、文件路径、配置项、',
        '  容器名、时间窗口等；缺哪一项就明说缺哪一项。',
        '- 在不同时间窗口、不同容器或不同代码路径之间交叉验证结论的一致性。',
        '- 优先做彻底的根因分析，而不是追求速度。',
        '- 若证据仍不足以给出确定结论，必须明确写出"目前缺少哪些证据"以及获取方式，',
        '  不得用猜测、臆测或合理推断来填补空缺。',
      ].join('\n')
    : [
        '',
        '快速分析模式：',
        '- 优先基于用户已经过滤的日志直接作答。',
        '- 仅在可见日志明显不足时才调用只读 docker 工具。',
        '- 回答简短，避免不必要的工具调用。',
      ].join('\n');
  return `${basePrompt}${tail}`;
}

/**
 * 创建一个 PI 会话。
 *
 * 会话用 SessionManager.create() 而不是 inMemory():每条消息会作为 JSONL
 * 追加到 ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl,
 * 会话结束后文件保留,重启后可用 SessionManager.open(sessionFile) 挂回。
 */
async function createSession({
  cwd, systemPrompt, docker, provider, modelId, thinkingLevel, supportsReasoning,
}) {
  const [lib, modelRuntime] = await Promise.all([loadPi(), loadModelRuntime()]);
  const { createAgentSession, DefaultResourceLoader, SessionManager } = lib;

  // ResourceLoader 负责加载系统提示词、技能和项目内扩展。
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: path.join(os.homedir(), '.pi', 'agent'),
    systemPrompt,
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.create(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir: path.join(os.homedir(), '.pi', 'agent'),
    sessionManager,
    modelRuntime,
    resourceLoader,
    // 只开放源码读取工具和只读 Docker 工具；不向 Agent 提供 bash/edit/write。
    tools: PI_READ_ONLY_TOOL_NAMES,
    customTools: createDockerTools(docker),
  });

  try {
    await configureSessionModel({
      session, modelRuntime, provider, modelId, thinkingLevel, supportsReasoning,
    });
  } catch (err) {
    session.dispose();
    throw err;
  }
  return { session, sessionFile: sessionManager.getSessionFile() };
}

/**
 * 重启后挂回一个已落盘的 PI 会话。
 *
 * 用 SessionManager.open(sessionFile) 重新读 JSONL entries,对话历史和
 * 上次的工具结果都会作为上下文带入下一次 prompt。cwd 必须和落盘时一致,
 * 否则 PI 会拒绝。
 */
async function openSession({
  cwd, systemPrompt, docker, sessionFile,
  provider, modelId, thinkingLevel, supportsReasoning,
}) {
  if (!sessionFile) throw new Error('sessionFile is required');
  const [lib, modelRuntime] = await Promise.all([loadPi(), loadModelRuntime()]);
  const { createAgentSession, DefaultResourceLoader, SessionManager } = lib;

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: path.join(os.homedir(), '.pi', 'agent'),
    systemPrompt,
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.open(sessionFile, undefined, cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir: path.join(os.homedir(), '.pi', 'agent'),
    sessionManager,
    modelRuntime,
    resourceLoader,
    tools: PI_READ_ONLY_TOOL_NAMES,
    customTools: createDockerTools(docker),
  });

  try {
    await configureSessionModel({
      session, modelRuntime, provider, modelId, thinkingLevel, supportsReasoning,
    });
  } catch (err) {
    session.dispose();
    throw err;
  }
  return { session, sessionFile: sessionManager.getSessionFile() ?? sessionFile };
}

/** 使用配置文件中的真实模型，并设置当前会话的思考等级。 */
async function configureSessionModel({
  session, modelRuntime, provider, modelId, thinkingLevel, supportsReasoning = true,
}) {
  const registeredModel = modelRuntime.getModel(provider, modelId);
  if (!registeredModel) throw new Error(`PI model not found: ${provider}/${modelId}`);

  // 自定义 models.json 可能漏写 reasoning；只修正当前内存模型，不改全局配置。
  const model = registeredModel.reasoning === supportsReasoning
    ? registeredModel
    : { ...registeredModel, reasoning: supportsReasoning };
  await session.setModel(model);
  session.setThinkingLevel(thinkingLevel);
  if (session.thinkingLevel !== thinkingLevel) {
    throw new Error(
      `PI model ${provider}/${modelId} does not support thinkingLevel=${thinkingLevel}`,
    );
  }
}

/** 统计 PI 工具结果中的文本字符数，仅用于日志展示。 */
function resultSize(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.reduce((size, item) =>
    size + (typeof item?.text === 'string' ? item.text.length : 0), 0);
}

/**
 * 对单个 PI 会话的轻量封装。
 *
 * 一个实例一次只处理一个问题。页面和日志需要的信息都通过回调返回。
 */
class PiAgent {
  constructor({
    docker,
    cwd = process.cwd(),
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    provider = 'minimax',
    modelId = 'MiniMax-M2.7',
    thinkingLevel = 'low',
    supportsReasoning = true,
    sessionFile = null,
  } = {}) {
    if (!docker) throw new Error('DockerClient is required');
    this.docker = docker;
    this.cwd = cwd;
    this.systemPrompt = systemPrompt;
    this.provider = provider;
    this.modelId = modelId;
    this.thinkingLevel = thinkingLevel;
    this.supportsReasoning = supportsReasoning;
    this.sessionFile = sessionFile;
    this.session = null;
    this.unsubscribe = null;
    this.currentRun = null;
  }

  async start() {
    const { session, sessionFile } = this.sessionFile
      ? await openSession({
          docker: this.docker,
          cwd: this.cwd,
          systemPrompt: this.systemPrompt,
          sessionFile: this.sessionFile,
          provider: this.provider,
          modelId: this.modelId,
          thinkingLevel: this.thinkingLevel,
          supportsReasoning: this.supportsReasoning,
        })
      : await createSession({
          docker: this.docker,
          cwd: this.cwd,
          systemPrompt: this.systemPrompt,
          provider: this.provider,
          modelId: this.modelId,
          thinkingLevel: this.thinkingLevel,
          supportsReasoning: this.supportsReasoning,
        });
    this.session = session;
    this.sessionFile = sessionFile;
    this.unsubscribe = this.session.subscribe((event) => this._onEvent(event));
    return this;
  }

  /** 发送问题并等待 PI 完成整个 Agent 循环。 */
  async prompt({ message, images }, callbacks = {}) {
    if (!this.session) throw new Error('pi session not ready');
    if (this.currentRun) throw new Error('pi session is already processing');

    const run = {
      text: '',
      thinking: '',
      message: null,
      aborted: false,
      startedAt: Date.now(),
      toolCalls: new Map(),
      callbacks,
    };
    this.currentRun = run;

    try {
      const options = Array.isArray(images) && images.length > 0 ? { images } : {};

      // PI 自己负责工具循环、自动重试和最终结束；这里直接等待即可。
      await this.session.prompt(message, options);

      if (run.message?.stopReason === 'error') {
        throw new Error(run.message.errorMessage || 'pi model returned an error');
      }
      return { text: run.text, message: run.message, partial: run.aborted };
    } finally {
      if (this.currentRun === run) this.currentRun = null;
    }
  }

  /**
   * 尽快把补充信息交给当前分析。
   * PI 会先完成正在执行的工具，再在下一次模型调用前加入这条信息。
   */
  async steer(message) {
    this._assertCanAppend(message);
    await this.session.steer(message);
  }

  /**
   * 把补充问题排到当前分析之后。
   * PI 会先完成当前 Agent 循环，再自动开始处理这条信息。
   */
  async followUp(message) {
    this._assertCanAppend(message);
    await this.session.followUp(message);
  }

  /** 请求 PI 中止当前问题。 */
  async abort() {
    if (!this.currentRun || !this.session) return;
    this.currentRun.aborted = true;
    await this.session.abort();
  }

  /** 释放订阅和 PI 会话；重复调用不会产生副作用。 */
  kill() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.dispose();
    this.session = null;
  }

  /** 追加信息只允许发给仍在运行的会话，避免悄悄开启新的分析。 */
  _assertCanAppend(message) {
    if (!this.session) throw new Error('pi session not ready');
    if (!this.currentRun) throw new Error('pi session is not processing');
    if (typeof message !== 'string' || !message.trim()) {
      throw new Error('additional message is required');
    }
  }

  /** 只转换页面和日志真正使用的 PI 事件。 */
  _onEvent(event) {
    const run = this.currentRun;
    if (!run) return;

    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if (update?.type === 'text_delta' && typeof update.delta === 'string') {
        run.text += update.delta;
        call(run.callbacks.onDelta, update.delta);
        return;
      }
      if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
        run.thinking += update.delta;
        call(run.callbacks.onThinkingDelta, update.delta);
        return;
      }
      return;
    }

    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      run.message = event.message;
      call(run.callbacks.onMessageEnd, event.message);
      return;
    }

    if (event.type === 'tool_execution_start') {
      run.toolCalls.set(event.toolCallId, {
        toolName: event.toolName || '?',
        startedAt: Date.now(),
        isError: false,
      });
      call(run.callbacks.onToolStart, {
        toolCallId: event.toolCallId,
        toolName: event.toolName || '?',
        args: event.args,
      });
      return;
    }

    if (event.type === 'tool_execution_update') {
      call(run.callbacks.onToolUpdate, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      });
      return;
    }

    if (event.type === 'tool_execution_end') {
      const tool = run.toolCalls.get(event.toolCallId) || { startedAt: Date.now() };
      tool.isError = !!event.isError;
      run.toolCalls.set(event.toolCallId, tool);
      call(run.callbacks.onToolEnd, {
        toolCallId: event.toolCallId,
        toolName: event.toolName || tool.toolName || '?',
        isError: tool.isError,
        resultSize: resultSize(event.result),
        durationMs: Date.now() - tool.startedAt,
      });
      return;
    }

    // willRetry=true 表示 PI 会自动继续，不应提前报告完成。
    if (event.type === 'agent_end' && !event.willRetry) {
      call(run.callbacks.onAgentEnd, {
        partial: run.aborted,
        durationMs: Date.now() - run.startedAt,
        textLength: run.text.length,
        thinkingLength: run.thinking.length,
        stopReason: run.message?.stopReason || null,
        toolCallCount: run.toolCalls.size,
        errorToolCalls: [...run.toolCalls.values()].filter((tool) => tool.isError).length,
      });
    }
  }
}

/** 调用可选回调，并隔离页面或日志代码抛出的异常。 */
function call(callback, value) {
  if (typeof callback !== 'function') return;
  try { callback(value); } catch (_) { /* 忽略外部回调异常 */ }
}

/** 创建、跟踪和释放独立的 PiAgent。 */
class PiAgentManager {
  constructor({
    docker,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    provider = 'minimax',
    modelId = 'MiniMax-M2.7',
    supportsReasoning = true,
  } = {}) {
    if (!docker) throw new Error('DockerClient is required');
    this.docker = docker;
    this.systemPrompt = systemPrompt;
    this.provider = provider;
    this.modelId = modelId;
    this.supportsReasoning = supportsReasoning;
    this.agents = new Set();
    this.closed = false;
  }

  async acquire({ analysisMode = 'quick', sessionFile = null } = {}) {
    if (this.closed) throw new Error('pi agent manager shutting down');
    const mode = ANALYSIS_MODES[analysisMode];
    if (!mode) throw new Error(`unknown analysis mode: ${analysisMode}`);
    const systemPrompt = buildSystemPrompt(this.systemPrompt, analysisMode);
    const agent = await new PiAgent({
      docker: this.docker,
      systemPrompt,
      provider: this.provider,
      modelId: this.modelId,
      thinkingLevel: mode.thinkingLevel,
      supportsReasoning: this.supportsReasoning,
      sessionFile,
    }).start();
    this.agents.add(agent);
    return agent;
  }

  release(agent) {
    this.agents.delete(agent);
    agent.kill();
  }

  shutdown() {
    this.closed = true;
    for (const agent of this.agents) agent.kill();
    this.agents.clear();
  }
}

module.exports = {
  PiAgent,
  PiAgentManager,
  DEFAULT_SYSTEM_PROMPT,
  ANALYSIS_MODES,
  buildSystemPrompt,
  configureSessionModel,
  openSession,
};
