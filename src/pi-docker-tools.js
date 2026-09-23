'use strict';

const { searchLines } = require('./search');

const DOCKER_TOOL_NAMES = Object.freeze([
  'docker_list_containers',
  'docker_get_logs',
  'docker_search_logs',
  'docker_get_stats',
]);

const PI_READ_ONLY_TOOL_NAMES = Object.freeze([
  'read',
  'grep',
  'find',
  'ls',
  ...DOCKER_TOOL_NAMES,
]);

/**
 * 创建 PI 可以直接调用的只读 Docker 工具。
 *
 * 工具直接复用 DockerClient，不经过 shell，因此不存在命令拼接和参数转义问题。
 */
function createDockerTools(docker) {
  if (!docker) throw new Error('DockerClient is required');

  return [
    {
      name: 'docker_list_containers',
      label: 'List Docker Containers',
      description: 'List all running Docker containers with their IDs, names, images, status, and ports.',
      parameters: objectSchema({}),
      execute: async () => jsonResult({
        containers: await docker.listRunning(),
      }),
    },
    {
      name: 'docker_get_logs',
      label: 'Get Docker Logs',
      description: 'Read the most recent log lines from a running Docker container. The result includes stable line numbers for citing evidence.',
      parameters: objectSchema({
        container: stringSchema('Container ID or name'),
        tail: integerSchema('Number of recent lines to read', 1, 5000, 200),
      }, ['container']),
      execute: async (_id, params) => {
        const tail = params.tail ?? 200;
        const lines = await docker.fetchLogs(params.container, { tail });
        const text = lines.map((line, index) => `[L${index + 1}] ${line}`).join('\n');
        return {
          content: [{ type: 'text', text: text || '(no logs)' }],
          details: { container: params.container, tail, returnedLines: lines.length },
        };
      },
    },
    {
      name: 'docker_search_logs',
      label: 'Search Docker Logs',
      description: 'Search recent Docker logs using a substring or regular expression and return matching lines with surrounding context.',
      parameters: objectSchema({
        container: stringSchema('Container ID or name'),
        query: stringSchema('Substring or regular expression to search for'),
        mode: {
          type: 'string',
          enum: ['substring', 'regex'],
          default: 'substring',
          description: 'Search mode',
        },
        tail: integerSchema('Number of recent lines to search', 1, 20_000, 2000),
        contextBefore: integerSchema('Context lines before each match', 0, 20, 10),
        contextAfter: integerSchema('Context lines after each match', 0, 20, 10),
        maxMatches: integerSchema('Maximum number of matches', 1, 200, 100),
      }, ['container', 'query']),
      execute: async (_id, params) => {
        const tail = params.tail ?? 2000;
        const lines = await docker.fetchLogs(params.container, { tail });
        const result = searchLines(lines, {
          query: params.query,
          mode: params.mode ?? 'substring',
          contextBefore: params.contextBefore ?? 10,
          contextAfter: params.contextAfter ?? 10,
          maxMatches: params.maxMatches ?? 100,
        });
        return jsonResult({
          container: params.container,
          query: params.query,
          ...result,
        });
      },
    },
    {
      name: 'docker_get_stats',
      label: 'Get Docker Stats',
      description: 'Read a one-time CPU, memory, and network usage snapshot for a running Docker container.',
      parameters: objectSchema({
        container: stringSchema('Container ID or name'),
      }, ['container']),
      execute: async (_id, params) => jsonResult({
        container: params.container,
        stats: await docker.getStats(params.container),
      }),
    },
  ];
}

/** 返回 PI 工具要求的文本内容和结构化详情。 */
function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

/** 以下三个小函数生成标准 JSON Schema，避免为了简单结构额外引入依赖。 */
function objectSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function stringSchema(description) {
  return { type: 'string', minLength: 1, description };
}

function integerSchema(description, minimum, maximum, defaultValue) {
  return {
    type: 'integer',
    minimum,
    maximum,
    default: defaultValue,
    description,
  };
}

module.exports = {
  createDockerTools,
  DOCKER_TOOL_NAMES,
  PI_READ_ONLY_TOOL_NAMES,
};
