'use strict';

/**
 * InvestigationManager —— 按 containerId 隐式粘合的"持续排障会话"。
 *
 * 默认行为不变:每个 ask 由 PiAgentManager 分配一个临时会话,跑完即释放。
 * 引入本类后,服务端会把同一个 containerId 的 ask 串到同一个会话上,
 * PI 可以在多轮提问之间保留上下文。
 *
 * 生命周期:
 *   - acquire({ containerId, ... }) → 命中空闲会话则复用,否则新建
 *   - 同一 containerId 在 idleMs 内的后续 acquire 都复用同一会话
 *   - 超过 idleMs 后,下一次 acquire 会释放旧会话再新建一个
 *   - close(containerId) 显式释放
 *   - shutdown() 在服务退出时释放全部会话
 *
 * 并发:同一会话同时只能跑一个 ask。acquire 时若发现 busy,返回 { busy: true },
 * 由 ws-router 决定如何提示用户。
 *
 * 复用限制:会话建立时使用的 analysisMode (quick/deep) 在整个生命周期内不变,
 * 复用时忽略新传入的 analysisMode。如果想换模式,请先 close 再 acquire。
 *
 * 持久化 (v2):
 *   - 落盘路径默认 ~/.pi/agent/sessions.json,可通过 storePath 覆盖。
 *   - 持久化字段: containerId → { sessionFile, lastActiveAt, analysisMode }。
 *   - sessionFile 是 PI 自己写的 JSONL 文件 (位于
 *     ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl),
 *     里面完整保留消息、工具结果和模型选择。
 *   - 重启后命中复用:用 SessionManager.open(sessionFile) 重新挂载,
 *     对话历史会作为上下文带入下一次 prompt。
 *   - 不持久化: live session 对象(client)和 busy 标记。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_STORE_PATH = path.join(os.homedir(), '.pi', 'agent', 'sessions.json');
const STORE_VERSION = 2;

class InvestigationManager {
  constructor({ agentManager, idleMs = DEFAULT_IDLE_MS, storePath = DEFAULT_STORE_PATH }) {
    if (!agentManager) throw new Error('agentManager is required');
    this._agentManager = agentManager;
    this._idleMs = idleMs;
    this._storePath = storePath;
    // containerId → { client, sessionFile, lastActiveAt, analysisMode, busy }
    this._sessions = new Map();
    this._loadFromDisk();
  }

  /**
   * 获取或创建 containerId 对应的会话。
   * 返回 { client, reused } 表示拿到会话;
   * 返回 { busy: true } 表示会话正忙(其它 ask 还在跑),调用方应稍后重试。
   */
  async acquire({ containerId, analysisMode }) {
    if (!containerId) throw new Error('containerId is required');
    const now = Date.now();
    const existing = this._sessions.get(containerId);
    if (existing && now - existing.lastActiveAt < this._idleMs) {
      if (existing.busy) return { busy: true };
      if (!existing.client) {
        // 重启恢复: 用磁盘上的 sessionFile 挂回同一 PI 会话。
        // 若 sessionFile 丢失/损坏 (磁盘被清、版本不兼容),降级为新建空白会话。
        try {
          existing.client = await this._agentManager.acquire({
            analysisMode: existing.analysisMode,
            sessionFile: existing.sessionFile,
          });
        } catch (err) {
          console.warn(`[investigation] reopen ${existing.sessionFile} failed (${err.message}); starting fresh`);
          existing.client = await this._agentManager.acquire({
            analysisMode: existing.analysisMode,
          });
          existing.sessionFile = existing.client.sessionFile ?? null;
          this._saveToDisk();
        }
        // lastActiveAt 保留磁盘值, 用于下一次空闲判断。
      } else {
        existing.lastActiveAt = now;
      }
      return { client: existing.client, reused: true };
    }
    if (existing) {
      // 空闲窗口已过, 旧会话丢弃。
      if (existing.client) this._agentManager.release(existing.client);
      this._sessions.delete(containerId);
    }
    const client = await this._agentManager.acquire({ analysisMode });
    const entry = {
      client,
      sessionFile: client.sessionFile ?? null,
      lastActiveAt: now,
      analysisMode,
      busy: false,
    };
    this._sessions.set(containerId, entry);
    this._saveToDisk();
    return { client, reused: false };
  }

  /** 把会话标记为"有 ask 在跑"。acquire 成功后立即调用。 */
  markBusy(containerId) {
    const entry = this._sessions.get(containerId);
    if (entry) entry.busy = true;
    // busy 不持久化, 不写盘。
  }

  /** 把会话标记为空闲。ask 正常结束、异常中止或 WS 断开时调用。 */
  markIdle(containerId) {
    const entry = this._sessions.get(containerId);
    if (entry) entry.busy = false;
  }

  /** 显式关闭 containerId 的会话。已 busy 的会话也会被立即释放。 */
  close(containerId) {
    const entry = this._sessions.get(containerId);
    if (!entry) return false;
    this._sessions.delete(containerId);
    if (entry.client) this._agentManager.release(entry.client);
    this._saveToDisk();
    return true;
  }

  /** 服务退出时调用, 释放所有会话并落盘 (清空后状态)。 */
  shutdown() {
    for (const [, entry] of this._sessions) {
      if (entry.client) this._agentManager.release(entry.client);
    }
    this._sessions.clear();
    this._saveToDisk();
  }

  // ---------- 落盘 ----------

  _loadFromDisk() {
    let raw;
    try {
      raw = fs.readFileSync(this._storePath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[investigation] failed to read ${this._storePath}: ${err.message}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`[investigation] invalid JSON in ${this._storePath}: ${err.message}`);
      return;
    }
    if (!parsed || parsed.version !== STORE_VERSION || typeof parsed.sessions !== 'object') {
      return;
    }
    for (const [containerId, meta] of Object.entries(parsed.sessions)) {
      if (!meta || typeof meta.lastActiveAt !== 'number') continue;
      // client=null, busy=false: 重启后用现有 sessionFile + analysisMode 懒挂回。
      this._sessions.set(containerId, {
        client: null,
        sessionFile: typeof meta.sessionFile === 'string' ? meta.sessionFile : null,
        lastActiveAt: meta.lastActiveAt,
        analysisMode: meta.analysisMode,
        busy: false,
      });
    }
  }

  _saveToDisk() {
    const sessions = {};
    for (const [containerId, entry] of this._sessions) {
      sessions[containerId] = {
        sessionFile: entry.sessionFile,
        lastActiveAt: entry.lastActiveAt,
        analysisMode: entry.analysisMode,
      };
    }
    const payload = JSON.stringify(
      { version: STORE_VERSION, idleMs: this._idleMs, sessions },
      null,
      2,
    );

    // 原子写: 写 .tmp 后 rename, 避免崩溃留下半截文件。
    try {
      fs.mkdirSync(path.dirname(this._storePath), { recursive: true });
      const tmpPath = this._storePath + '.tmp';
      fs.writeFileSync(tmpPath, payload);
      fs.renameSync(tmpPath, this._storePath);
    } catch (err) {
      console.warn(`[investigation] failed to write ${this._storePath}: ${err.message}`);
    }
  }
}

module.exports = {
  InvestigationManager,
  DEFAULT_IDLE_MS,
  DEFAULT_STORE_PATH,
  STORE_VERSION,
};
