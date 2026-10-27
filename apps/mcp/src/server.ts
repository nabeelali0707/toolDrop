import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ToolDropError, type ToolDropErrorJson } from '@tooldrop/core';
import type { PublishedTool } from '@tooldrop/db';
import type { Engine, Scopes } from '@tooldrop/engine';

// toolDrop's MCP server (SPEC, MCP and REST interfaces): fixed management
// tools, plus one tool per published recipe, refreshed with list_changed.

export interface McpOptions {
  /** Tools the caller may use; local stdio clients get all of them. */
  scopes?: Scopes;
  /** toolDrop's version, reported to clients. */
  version?: string;
}

const INSTRUCTIONS = `toolDrop turns tasks on websites into tools. Every published tool is listed as its own tool: call it directly with its inputs. Results are plain data, returned in a second or two without a model. Use find_tool to search published tools by site or task, and run_tool to run one by name.
To make a new tool, call build_tool with the site's URL and the task. A build takes one to a few minutes: poll get_job every 15 seconds until it succeeds or fails. When a job asks a question (status waiting_for_answer), ask the user if you cannot answer it yourself, then call answer_question. Always ask the user before building a tool with authority "write".`;

const META_SCHEMA = {
  type: 'object',
  properties: {
    strategy: {
      type: 'string',
      description: 'How the call ran: official_api, http_replay, html_fetch or browser_script.',
    },
    duration_ms: { type: 'integer' },
    recipe_version: { type: 'integer' },
    healed: { type: 'boolean' },
  },
};

const MANAGEMENT_TOOLS: Tool[] = [
  {
    name: 'find_tool',
    title: 'Find a tool',
    description:
      'Search the published tools by site and task. Returns each match with its name, description and inputs.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Part of the site address, e.g. "supplier.example.com".' },
        task: { type: 'string', description: 'What you want to do, e.g. "list my invoices".' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'run_tool',
    title: 'Run a tool',
    description:
      'Run a published tool by name. Every published tool is also listed as its own tool, so prefer calling it directly.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool to run.' },
        input: { type: 'object', description: "The tool's inputs." },
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
];

/** Tools that change what every caller sees, listed only for callers with access to every tool. */
const BUILD_TOOLS: Tool[] = [
  {
    name: 'build_tool',
    title: 'Build a tool',
    description:
      'Build a new tool for a task on a website. Starts a build job and returns it at once; poll get_job until it finishes. Ask the user before building with authority "write".',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The page where the task starts, e.g. "https://shop.example.com/orders".',
        },
        task: {
          type: 'string',
          description:
            'What the tool does, in plain words, e.g. "list my orders with status and delivery date".',
        },
        authority: {
          type: 'string',
          enum: ['read', 'write'],
          description: '"read" for tools that only fetch data; "write" for tools that change it.',
        },
        inputs_hint: {
          type: 'string',
          description: 'Optional: which values the tool should take as inputs.',
        },
        recording_id: {
          type: 'string',
          description: 'Optional: a recording of the task, from `tooldrop record` or the Chrome extension.',
        },
      },
      required: ['url', 'task', 'authority'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'get_job',
    title: 'Check a build',
    description:
      'The status of a build job: what it is doing, its questions, and when it succeeds, the new tool with sample results.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'answer_question',
    title: 'Answer a build question',
    description: 'Answer a question a build job asked (status waiting_for_answer); the build then continues.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        question_id: { type: 'string' },
        answer: { type: 'string', description: 'The answer; one of the options when the question has them.' },
      },
      required: ['job_id', 'question_id', 'answer'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
];

export function createMcpServer(engine: Engine, options: McpOptions = {}): Server {
  const scopes = options.scopes ?? ['*'];
  const server = new Server(
    { name: 'tooldrop', title: 'toolDrop', version: options.version ?? '0.0.0' },
    { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
  );

  const management = scopes.includes('*') ? [...MANAGEMENT_TOOLS, ...BUILD_TOOLS] : MANAGEMENT_TOOLS;
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...management, ...engine.listTools(scopes).map(toMcpTool)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
    const args = params.arguments ?? {};
    try {
      if (params.name === 'build_tool') return success({ job: engine.startBuild(args, scopes) });
      if (params.name === 'get_job') {
        return success({ job: engine.getJob(requiredString(args.job_id, 'job_id'), scopes) });
      }
      if (params.name === 'answer_question') {
        const job = engine.answerQuestion(
          requiredString(args.job_id, 'job_id'),
          requiredString(args.question_id, 'question_id'),
          requiredString(args.answer, 'answer'),
          scopes,
        );
        return success({ job });
      }
      if (params.name === 'find_tool') {
        const query = { site: optionalString(args.site, 'site'), task: optionalString(args.task, 'task') };
        return success({ tools: engine.findTools(query, scopes).map(describeTool) });
      }
      if (params.name === 'run_tool') {
        if (typeof args.name !== 'string')
          throw new ToolDropError('invalid_input', 'run_tool needs a "name"');
        return success(await run(engine, args.name, args.input ?? {}, scopes));
      }
      return success(await run(engine, params.name, args, scopes));
    } catch (error) {
      return failure(error);
    }
  });

  const unsubscribe = engine.onToolsChanged(() => {
    server.sendToolListChanged().catch(() => undefined);
  });
  server.onclose = unsubscribe;
  return server;
}

/** Serves MCP over stdio, for clients that start toolDrop themselves (Claude Desktop, Claude Code, Cursor, VS Code). */
export async function serveStdio(engine: Engine, options: McpOptions = {}): Promise<Server> {
  const server = createMcpServer(engine, options);
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Handles one Streamable HTTP request, for remote clients. Stateless: each
 * request gets its own server, so there are no sessions to keep, and
 * list_changed is not pushed over HTTP.
 */
export async function handleMcpHttp(
  engine: Engine,
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  options: McpOptions = {},
): Promise<void> {
  const server = createMcpServer(engine, options);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}

async function run(engine: Engine, name: string, input: unknown, scopes: Scopes) {
  const { result, meta } = await engine.runTool(name, input, scopes);
  return { result, meta };
}

function toMcpTool(tool: PublishedTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema as Tool['inputSchema'],
    outputSchema: {
      type: 'object',
      properties: { result: tool.output_schema, meta: META_SCHEMA },
      required: ['result', 'meta'],
    },
    annotations: { readOnlyHint: tool.authority === 'read', openWorldHint: true },
  };
}

function describeTool(tool: PublishedTool) {
  return {
    name: tool.name,
    description: tool.description,
    site: tool.site.origin,
    authority: tool.authority,
    input_schema: tool.input_schema,
  };
}

function success(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function failure(error: unknown): CallToolResult {
  const json: ToolDropErrorJson =
    error instanceof ToolDropError
      ? error.toJSON()
      : { code: 'internal', message: error instanceof Error ? error.message : String(error) };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: json }) }] };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new ToolDropError('invalid_input', `"${name}" is required and must be a string`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ToolDropError('invalid_input', `"${name}" must be a string`);
  return value;
}
