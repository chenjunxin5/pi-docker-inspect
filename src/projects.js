'use strict';

/**
 * Project → source-repo mapping.
 *
 * Reads `config/projects.json` once at startup. Each entry maps a docker
 * container **name** (stable, user-chosen) to a local clone of its source
 * repo, so PI can `read` / `grep` into the actual application code when
 * investigating container errors.
 *
 * Schema (config/projects.json):
 *   {
 *     "<containerName>": {
 *       "repo":        "<git URL>",
 *       "branch":      "<branch name>",   // required
 *       "localPath":   "~/projects/foo",  // ~ expanded
 *       "description": "<one-liner>"      // shown in PI prompt hint
 *     }
 *   }
 *
 * A missing or malformed config file is treated as "no mappings" — never
 * throws at startup, since the mapping is opt-in.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function loadProjects(rootDir) {
  const configPath = path.join(rootDir, 'config', 'projects.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return { _configPath: configPath, _missing: true, mappings: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[projects] failed to parse ${configPath}: ${err.message}`);
    return { _configPath: configPath, _missing: false, _invalid: true, mappings: {} };
  }

  const homedir = os.homedir();
  const mappings = {};
  for (const [name, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== 'object') continue;
    const localPath = typeof entry.localPath === 'string' && entry.localPath.startsWith('~')
      ? path.join(homedir, entry.localPath.slice(2))
      : entry.localPath;
    mappings[name] = {
      name,
      repo: entry.repo,
      branch: entry.branch,
      localPath,
      description: entry.description || '',
    };
  }
  return { _configPath: configPath, _missing: false, mappings };
}

/**
 * Look up a project mapping for a given container name.
 * Returns null when not found or when the entry has no localPath.
 */
function findProjectForContainer(loaded, containerName) {
  if (!containerName || !loaded || !loaded.mappings) return null;
  return loaded.mappings[containerName] || null;
}

module.exports = { loadProjects, findProjectForContainer };