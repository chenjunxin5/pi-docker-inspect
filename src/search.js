'use strict';

/**
 * Substring / regex search over an array of log lines with surrounding context.
 *
 * Returns:
 *   { matches: [{ lineNo, text, before:[text], after:[text] }],
 *     truncated, totalScanned }
 * or:
 *   { error: 'invalid_regex', totalScanned }
 *
 * - Substring mode uses String.prototype.includes (safe from ReDoS).
 * - Regex mode pre-compiles in a try/catch and applies a wall-clock budget
 *   (200 ms) so a pathological pattern cannot lock up the request.
 */

const REGEX_BUDGET_MS = 200;
const DEFAULT_MAX_MATCHES = 500;
const DEFAULT_CONTEXT_BEFORE = 10;
const DEFAULT_CONTEXT_AFTER = 10;

function searchLines(lines, opts = {}) {
  const {
    query,
    mode = 'substring',
    contextBefore = DEFAULT_CONTEXT_BEFORE,
    contextAfter = DEFAULT_CONTEXT_AFTER,
    maxMatches = DEFAULT_MAX_MATCHES,
  } = opts;

  if (typeof query !== 'string' || query.length === 0) {
    return { matches: [], truncated: false, totalScanned: lines.length };
  }

  let tester;
  if (mode === 'regex') {
    let re;
    try {
      re = new RegExp(query);
    } catch (err) {
      return { error: 'invalid_regex', message: err.message, totalScanned: lines.length };
    }
    tester = (line) => {
      const m = line.match(re);
      return m ? m.index : -1;
    };
  } else {
    tester = (line) => line.indexOf(query);
  }

  const matches = [];
  let truncated = false;
  const startedAt = Date.now();
  const totalScanned = lines.length;

  for (let i = 0; i < lines.length; i++) {
    if (mode === 'regex' && (Date.now() - startedAt) > REGEX_BUDGET_MS) {
      truncated = true;
      break;
    }
    const line = lines[i] ?? '';
    const idx = tester(line);
    if (idx === -1) continue;

    const before = [];
    for (let k = 1; k <= contextBefore; k++) {
      if (i - k >= 0) before.push(lines[i - k]);
    }
    const after = [];
    for (let k = 1; k <= contextAfter; k++) {
      if (i + k < lines.length) after.push(lines[i + k]);
    }

    matches.push({
      lineNo: i + 1,           // 1-based for human readability
      text: line,
      before,
      after,
    });

    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
  }

  return { matches, truncated, totalScanned };
}

module.exports = { searchLines };