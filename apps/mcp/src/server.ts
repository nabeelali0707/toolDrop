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
import { keyAllows, type PublishedTool } from '@tooldrop/db';
import { callInputSchema, type Engine, type Scopes } from '@tooldrop/engine';

// toolDrop's MCP server (SPEC, MCP and REST interfaces): fixed management
// tools, plus one tool per published recipe, refreshed with list_changed.

export interface McpOptions {
  /** Tools the caller may use; local stdio clients get all of them. */
  scopes?: Scopes;
  /** toolDrop's version, reported to clients. */
  version?: string;
  /** Who the client is, for the write audit log (default "mcp"). */
  by?: string;
}

const INSTRUCTIONS = `toolDrop turns tasks on websites into tools. Every published tool is listed as its own tool: call it directly with its inputs. Results are plain data, returned in a second or two without a model. Use find_tool to search published tools by site or task, and run_tool to run one by name. Use create_watch to be told when a read tool's result changes.
A tool with authority "write" changes the site, so it never acts at once: a call returns a preview (the fields it will fill, the page, a screenshot) and an approval_id. Show the preview to the user and call approve_action only with their decision. Pass dry_run: true to see a preview without asking for approval.
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
  {
    name: 'approve_action',
    title: 'Approve or reject a write',
    description:
      "Decide on a write tool's preview. Approving makes the write at once and returns its result; rejecting changes nothing. Only call this with the user's own decision, after showing them the preview.",
    inputSchema: {
      type: 'object',
      properties: {
        approval_id: { type: 'string', description: "The approval_id from the write tool's preview." },
        decision: { type: 'string', enum: ['approve', 'reject'] },
      },
      required: ['approval_id', 'decision'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'create_watch',
    title: 'Watch a tool for changes',
    description:
      'Run a read tool every interval (at least 300 seconds) and POST each new, changed or removed row to a webhook, signed with HMAC-SHA256. The first run is the baseline. Returns the watch and the signing secret, which is shown only once. Changes also arrive here as log notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'The read tool to run.' },
        inputs: { type: 'object', description: "The tool's inputs, the same on every run." },
        interval_s: { type: 'integer', minimum: 300, description: 'Seconds between runs.' },
        key_field: {
          type: 'string',
          description: 'The output field that tells rows apart, such as an invoice number.',
        },
        webhook_url: { type: 'string', description: 'Where to POST each change (http or https).' },
      },
      required: ['tool', 'interval_s', 'key_field', 'webhook_url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: 'list_watches',
    title: 'List watches',
    description: 'The watches on tools you can use, with when each last ran and its last error.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'delete_watch',
    title: 'Delete a watch',
    description: 'Stop a watch. Its webhook gets no more events.',
    inputSchema: {
      type: 'object',
      properties: { watch_id: { type: 'string' } },
      required: ['watch_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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

/** Saved logins (SPEC, Management MCP tools); like builds, they need access to every tool. */
const LOGIN_TOOLS: Tool[] = [
  {
    name: 'add_login',
    title: 'Save a login',
    description:
      'Save a login for a site, so toolDrop can sign in there when it builds and runs tools. Only call it with credentials the user gave you for this. The values are encrypted on this machine and never returned. The user can also add logins without sharing them: `tooldrop logins add <site>`.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Any page of the site, e.g. "https://shop.example.com".' },
        username: { type: 'string' },
        password: { type: 'string' },
        label: { type: 'string', description: 'Optional: a name for this login, e.g. "work account".' },
        totp_secret: {
          type: 'string',
          description: 'Optional: the authenticator secret (base32), for sites that ask for 6-digit codes.',
        },
        twofa: {
          type: 'string',
          enum: ['human'],
          description:
            'Optional: "human" when codes arrive another way and toolDrop should ask for each one.',
        },
      },
      required: ['site', 'username', 'password'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  {
    name: 'list_logins',
    title: 'List saved logins',
    description: 'Saved logins, with masked usernames. Passwords and secrets are never shown.',
    inputSchema: {
      type: 'object',
      properties: { site: { type: 'string', description: 'Optional: only logins for this site.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];

export function createMcpServer(engine: Engine, options: McpOptions = {}): Server {
  const scopes = options.scopes ?? ['*'];
  const by = options.by ?? 'mcp';
  const server = new Server(
    { name: 'tooldrop', title: 'toolDrop', version: options.version ?? '0.0.0' },
    { capabilities: { tools: { listChanged: true }, logging: {} }, instructions: INSTRUCTIONS },
  );

  const management = scopes.includes('*')
    ? [...MANAGEMENT_TOOLS, ...BUILD_TOOLS, ...LOGIN_TOOLS]
    : MANAGEMENT_TOOLS;
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...management, ...engine.listTools(scopes).map(toMcpTool)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
    const args = params.arguments ?? {};
    try {
      if (params.name === 'build_tool') return success({ job: engine.startBuild(args, scopes) });
      if (params.name === 'add_login') return success({ login: await engine.addLogin(args, scopes) });
      if (params.name === 'list_logins') {
        return success({ logins: await engine.listLogins(scopes, optionalString(args.site, 'site')) });
      }
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
      if (params.name === 'approve_action') {
        const id = requiredString(args.approval_id, 'approval_id');
        return success(await engine.decideApproval(id, args.decision, scopes, by));
      }
      if (params.name === 'create_watch') return success(await engine.createWatch(args, scopes));
      if (params.name === 'list_watches') return success({ watches: engine.listWatches(scopes) });
      if (params.name === 'delete_watch') {
        const id = requiredString(args.watch_id, 'watch_id');
        engine.deleteWatch(id, scopes);
        return success({ deleted: id });
      }
      if (params.name === 'find_tool') {
        const query = { site: optionalString(args.site, 'site'), task: optionalString(args.task, 'task') };
        return success({ tools: engine.findTools(query, scopes).map(describeTool) });
      }
      if (params.name === 'run_tool') {
        if (typeof args.name !== 'string')
          throw new ToolDropError('invalid_input', 'run_tool needs a "name"');
        return await run(engine, args.name, args.input ?? {}, scopes);
      }
      return await run(engine, params.name, args, scopes);
    } catch (error) {
      return failure(error, previewImage(engine, error, scopes));
    }
  });

  const unsubscribe = engine.onToolsChanged(() => {
    server.sendToolListChanged().catch(() => undefined);
  });
  // Watch events as MCP log messages, which every client understands (SPEC, Watches).
  const unwatch = engine.watches.onEvent((event) => {
    if (!keyAllows(scopes, event.tool)) return;
    server
      .sendLoggingMessage({ level: 'info', logger: 'tooldrop.watches', data: event })
      .catch(() => undefined);
  });
  server.onclose = () => {
    unsubscribe();
    unwatch();
  };
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

/** Runs a tool. A write tool's dry run comes with a picture of the filled form. */
async function run(engine: Engine, name: string, input: unknown, scopes: Scopes): Promise<CallToolResult> {
  const { result, meta, screenshot } = await engine.runTool(name, input, scopes);
  return success({ result, meta }, screenshot);
}

/** The filled form of a write waiting for approval, so the user sees what they approve. */
function previewImage(engine: Engine, error: unknown, scopes: Scopes): Buffer | undefined {
  if (!(error instanceof ToolDropError) || error.code !== 'approval_required') return undefined;
  const id = (error.details as { approval_id?: unknown } | undefined)?.approval_id;
  try {
    return typeof id === 'string' ? engine.approvalScreenshot(id, 'before', scopes) : undefined;
  } catch {
    return undefined;
  }
}

function toMcpTool(tool: PublishedTool): Tool {
  const read = tool.authority === 'read';
  return {
    name: tool.name,
    description: read
      ? tool.description
      : `${tool.description} Changes the site: a call returns a preview and an approval_id, and acts only once approved with approve_action.`,
    inputSchema: callInputSchema(tool) as Tool['inputSchema'],
    // A write answers with a preview, a dry run or its result, so it declares no one output shape.
    ...(read && {
      outputSchema: {
        type: 'object',
        properties: { result: tool.output_schema, meta: META_SCHEMA },
        required: ['result', 'meta'],
      },
    }),
    annotations: { readOnlyHint: read, destructiveHint: !read, openWorldHint: true },
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

function success(value: Record<string, unknown>, image?: Buffer): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }, ...imageContent(image)],
    structuredContent: value,
  };
}

function imageContent(image: Buffer | undefined): CallToolResult['content'] {
  return image ? [{ type: 'image', data: image.toString('base64'), mimeType: 'image/png' }] : [];
}

function failure(error: unknown, image?: Buffer): CallToolResult {
  const json: ToolDropErrorJson =
    error instanceof ToolDropError
      ? error.toJSON()
      : { code: 'internal', message: error instanceof Error ? error.message : String(error) };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: json }) }, ...imageContent(image)],
  };
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
