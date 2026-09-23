'use strict';

/**
 * dockerode wrapper.
 *
 * Exposes:
 *   - listRunning()
 *   - fetchLogs(id, { tail })         -> string[]
 *   - followLogs(id, { tail, onLine, onError, onEnd }) -> { stop() }
 *   - getStats(id)
 *
 * The Docker log stream uses an 8-byte header format:
 *   [streamType(1)][0(3)][sizeBE(4)]
 * where streamType is 1=stdout, 2=stderr. When the daemon returns the logs as
 * a Buffer (non-follow), we demux manually. For follow mode, dockerode already
 * demuxes into an object-mode Readable with { stdout, stderr } Buffers; we
 * branch on the first chunk's shape.
 */

const Docker = require('dockerode');

const STDOUT = 1;
const STDERR = 2;
const MAX_LINE_BYTES = 16 * 1024;   // per-line cap when streaming
const FOLLOW_QUEUE_CAP = 5000;      // back-pressure threshold

class DockerClient {
  /**
   * @param {object} opts
   * @param {string} [opts.socketPath]   unix socket path
   * @param {string} [opts.host]         tcp host (when DOCKER_HOST set)
   * @param {number} [opts.port]
   */
  constructor(opts = {}) {
    let dockerOpts = {};
    if (opts.socketPath) {
      dockerOpts.socketPath = opts.socketPath;
    } else if (opts.host) {
      dockerOpts.host = opts.host;
      dockerOpts.port = opts.port || 2375;
      if (opts.protocol === 'https') dockerOpts.protocol = 'https';
    } else if (process.env.DOCKER_HOST) {
      // Parse DOCKER_HOST=tcp://host:port
      const m = process.env.DOCKER_HOST.match(/^(tcp|unix):\/\/(.+?)(?::(\d+))?$/);
      if (m) {
        if (m[1] === 'unix') dockerOpts.socketPath = m[2];
        else { dockerOpts.host = m[2]; dockerOpts.port = Number(m[3] || 2375); }
      }
    }
    this.docker = new Docker(dockerOpts);
  }

  /** List running containers. */
  async listRunning() {
    const summaries = await this.docker.listContainers({ all: false });
    return summaries.map((s) => ({
      id: s.Id,
      name: (s.Names && s.Names[0] ? s.Names[0].replace(/^\//, '') : s.Id.slice(0, 12)),
      image: s.Image,
      state: s.State,         // 'running'
      status: s.Status,       // "Up 3 days"
      ports: (s.Ports || []).map((p) => ({
        privatePort: p.PrivatePort,
        publicPort: p.PublicPort,
        type: p.Type,
        ip: p.IP,
      })),
      created: s.Created,
    }));
  }

  /** Fetch last N log lines (non-follow). Returns string[]. */
  async fetchLogs(id, { tail = 500 } = {}) {
    const container = this.docker.getContainer(id);
    const buf = await container.logs({
      follow: false,
      stdout: true,
      stderr: true,
      tail,
      timestamps: false,
    });
    return demuxBuffer(buf);
  }

  /** Start following a container's logs. */
  followLogs(id, { tail = 500, onLine, onError, onEnd } = {}) {
    const container = this.docker.getContainer(id);
    let stopped = false;
    let objectMode = null;     // determined lazily from first chunk
    let stdoutTail = '';       // partial-line buffers
    let stderrTail = '';
    let queueDepth = 0;
    let source = null;
    let dataHandler = null;
    let stderrHandler = null;
    let endHandler = null;
    let errorHandler = null;
    let closeHandler = null;

    container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    }).then((stream) => {
      if (stopped) {
        try { stream.destroy(); } catch (_) { /* ignore */ }
        return;
      }
      source = stream;

      dataHandler = (chunk) => {
        if (stopped) return;
        // First-chunk probe.
        if (objectMode === null) {
          objectMode = typeof chunk === 'object' && chunk !== null
            && ('stdout' in chunk || 'stderr' in chunk);
        }

        if (objectMode) {
          if (chunk.stdout) stdoutTail = consume(chunk.stdout, 'stdout', stdoutTail);
          if (chunk.stderr) stderrTail = consume(chunk.stderr, 'stderr', stderrTail);
        } else {
          // Raw Buffer demux.
          const demuxed = demuxBuffer(chunk, /*asLines*/ false);
          for (const ln of demuxed) {
            onLineSafe(ln.stream, ln.text);
          }
        }
      };
      errorHandler = (err) => {
        if (stopped) return;
        try { onError?.(err); } catch (_) { /* ignore */ }
      };
      endHandler = () => {
        if (stopped) return;
        flushTail(stdoutTail, 'stdout');
        flushTail(stderrTail, 'stderr');
        try { onEnd?.(); } catch (_) { /* ignore */ }
      };
      closeHandler = () => {
        if (stopped) return;
        flushTail(stdoutTail, 'stdout');
        flushTail(stderrTail, 'stderr');
        try { onEnd?.(); } catch (_) { /* ignore */ }
      };

      source.on('data', dataHandler);
      source.on('error', errorHandler);
      source.on('end', endHandler);
      source.on('close', closeHandler);
    }).catch((err) => {
      if (stopped) return;
      try { onError?.(err); } catch (_) { /* ignore */ }
    });

    function onLineSafe(stream, text) {
      queueDepth += 1;
      try { onLine?.({ stream, text, ts: Date.now() }); } catch (_) { /* ignore */ }
      queueDepth -= 1;
      // Back-pressure: if consumer is falling behind, pause + resume next tick.
      if (queueDepth > FOLLOW_QUEUE_CAP && source && !source.paused) {
        try { source.pause(); } catch (_) { /* ignore */ }
        setImmediate(() => {
          if (!stopped && source) {
            try { source.resume(); } catch (_) { /* ignore */ }
          }
        });
      }
    }

    function flushTail(tailStr, stream) {
      if (tailStr) onLineSafe(stream, tailStr);
      if (stream === 'stdout') stdoutTail = '';
      else stderrTail = '';
    }

    function consume(buf, stream, tailStr) {
      const text = tailStr + buf.toString('utf8');
      const parts = text.split('\n');
      const leftover = parts.pop();
      for (const line of parts) {
        const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
        onLineSafe(stream, trimmed);
      }
      return leftover;
    }

    return {
      stop() {
        if (stopped) return;
        stopped = true;
        if (source) {
          try {
            if (dataHandler) source.off?.('data', dataHandler);
            if (errorHandler) source.off?.('error', errorHandler);
            if (endHandler) source.off?.('end', endHandler);
            if (closeHandler) source.off?.('close', closeHandler);
          } catch (_) { /* ignore */ }
          try { source.destroy(); } catch (_) { /* ignore */ }
        }
        source = null;
      },
    };
  }

  /** One-shot stats snapshot. */
  async getStats(id) {
    const container = this.docker.getContainer(id);
    const s = await container.stats({ stream: false });
    // Compute cpu% (Docker cgroup v1 + v2).
    let cpuPerc = 0;
    try {
      const cpuDelta = Number(s.cpu_stats?.cpu_usage?.total_usage || 0)
        - Number(s.precpu_stats?.cpu_usage?.total_usage || 0);
      const sysDelta = Number(s.cpu_stats?.system_cpu_usage || 0)
        - Number(s.precpu_stats?.system_cpu_usage || 0);
      const cores = Number(s.cpu_stats?.online_cpus
        || (s.cpu_stats?.cpu_usage?.percpu_usage?.length)
        || 1);
      if (sysDelta > 0 && cpuDelta > 0) {
        cpuPerc = (cpuDelta / sysDelta) * cores * 100;
      }
    } catch (_) { /* ignore */ }
    return {
      cpuPerc,
      memUsage: s.memory_stats?.usage || 0,
      memLimit: s.memory_stats?.limit || 0,
      netRx: sumNet(s, 'rx_bytes'),
      netTx: sumNet(s, 'tx_bytes'),
    };
  }
}

function sumNet(stats, key) {
  if (!stats?.networks) return 0;
  let total = 0;
  for (const iface of Object.values(stats.networks)) {
    total += Number(iface[key] || 0);
  }
  return total;
}

/**
 * Demultiplex a Docker logs Buffer (or array of Buffer lines) by 8-byte header.
 * If `asLines` is true, returns string[]. Otherwise returns { stream, text }[].
 */
function demuxBuffer(input, asLines = true) {
  let buf;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (Array.isArray(input)) {
    buf = Buffer.concat(input.map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b))));
  } else if (input && typeof input === 'object' && (input.stdout || input.stderr)) {
    // Object-mode (already demuxed): combine.
    const out = [];
    if (input.stdout) out.push(...splitLines(input.stdout, 'stdout'));
    if (input.stderr) out.push(...splitLines(input.stderr, 'stderr'));
    return asLines ? out.map((l) => l.text) : out;
  } else {
    buf = Buffer.from(input || '');
  }

  const out = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const streamType = buf.readUInt8(offset);
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) break;   // truncated frame
    const payload = buf.subarray(offset, offset + size);
    offset += size;

    const stream = streamType === STDERR ? 'stderr' : streamType === STDOUT ? 'stdout' : null;
    if (!stream) continue;
    for (const ln of splitLines(payload, stream)) out.push(ln);
  }
  return asLines ? out.map((l) => l.text) : out;
}

function splitLines(buf, stream) {
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .filter((l) => l.length > 0)
    .map((l) => ({ stream, text: l }));
}

module.exports = { DockerClient, demuxBuffer };