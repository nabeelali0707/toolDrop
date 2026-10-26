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

const INSTRUCTIONS = `toolDrop turns tasks on websites into tools. Every published tool is listed as its own tool: call it directly with its inputs. Results are plain data, returned in a second or two without a model. Use find_tool to search published tools by site or task, and run_tool to run one by name. Building new tools from a description arrives in a later release.`;

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

export function createMcpServer(engine: Engine, options: McpOptions = {}): Server {
  const scopes = options.scopes ?? ['*'];
  const server = new Server(
    { name: 'tooldrop', title: 'toolDrop', version: options.version ?? '0.0.0' },
    { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...MANAGEMENT_TOOLS, ...engine.listTools(scopes).map(toMcpTool)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
    const args = params.arguments ?? {};
    try {
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

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ToolDropError('invalid_input', `"${name}" must be a string`);
  return value;
}
