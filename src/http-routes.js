'use strict';

const express = require('express');

/**
 * REST endpoints:
 *   GET /api/health
 *   GET /api/containers
 *   GET /api/containers/:id/logs?tail=500
 *   GET /api/containers/:id/stats
 */
function createHttpRouter({ docker }) {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: '0.1.0', ts: Date.now() });
  });

  router.get('/containers', async (_req, res) => {
    try {
      const containers = await docker.listRunning();
      res.json({ containers });
    } catch (err) {
      const e = toApiError(err);
      res.status(e.status).json({ error: e });
    }
  });

  router.get('/containers/:id/logs', async (req, res) => {
    const tail = clamp(parseInt(req.query.tail, 10) || 500, 1, 100_000);
    try {
      const lines = await docker.fetchLogs(req.params.id, { tail });
      res.json({ containerId: req.params.id, tail, lines });
    } catch (err) {
      const e = toApiError(err);
      res.status(e.status).json({ error: e });
    }
  });

  router.get('/containers/:id/stats', async (req, res) => {
    try {
      const stats = await docker.getStats(req.params.id);
      res.json({ containerId: req.params.id, stats });
    } catch (err) {
      const e = toApiError(err);
      res.status(e.status).json({ error: e });
    }
  });

  return router;
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function toApiError(err) {
  const msg = err && err.message ? err.message : String(err);
  const status = err && err.statusCode ? err.statusCode
    : /ENOENT|EACCES|ECONNREFUSED/.test(msg) ? 503
    : 500;
  return { code: err?.code || 'INTERNAL', message: msg, status };
}

module.exports = { createHttpRouter };