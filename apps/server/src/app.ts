import { ToolDropError, type ErrorCode, type ToolDropErrorJson } from '@tooldrop/core';
import { verifyApiKey, type PublishedTool } from '@tooldrop/db';
import type { Engine, Scopes } from '@tooldrop/engine';
import { handleMcpHttp } from '@tooldrop/mcp';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

// The REST API (SPEC, MCP and REST interfaces) and remote MCP. Every route but
// /health needs a bearer API key; `tooldrop keys create` makes one.

export interface ServerOptions {
  engine: Engine;
  /** toolDrop's version, for /health and MCP clients. */
  version?: string;
}

const STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  approval_required: 409,
  rate_limited: 429,
  internal: 500,
  invalid_output: 502,
  strategy_failed: 502,
  session_expired: 502,
  llm_invalid_output: 502,
  llm_prompt_too_large: 502,
  llm_unavailable: 503,
  vault_unavailable: 503,
  heal_timeout: 504,
};

declare module 'fastify' {
  interface FastifyRequest {
    /** The tools the caller's API key may use. */
    scopes: Scopes;
  }
}

export function createServer({ engine, version = '0.0.0' }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest('scopes', null as unknown as Scopes);

  app.addHook('onRequest', (request, _reply, done) => {
    if (request.url === '/health') return done();
    try {
      request.scopes = authenticate(engine, request);
      done();
    } catch (error) {
      done(error as Error);
    }
  });

  app.setErrorHandler(async (error, _request, reply) => {
    const json = toErrorJson(error);
    // Fastify's own client errors keep their status (400, 413, 415); ours map from the code.
    const status =
      !(error instanceof ToolDropError) && hasStatus(error) ? error.statusCode : STATUS[json.code];
    return reply.code(status).send({ error: json });
  });

  app.get('/health', () => ({ ok: true, version }));

  app.get('/v1/tools', (request) => ({ tools: engine.listTools(request.scopes).map(describeTool) }));

  app.post('/v1/tools/:name/run', async (request) => {
    const { name } = request.params as { name: string };
    const { result, meta } = await engine.runTool(name, request.body ?? {}, request.scopes);
    return { result, meta };
  });

  // Builds run as jobs: start one, poll it, answer its questions (SPEC, REST API).
  app.post('/v1/builds', async (request, reply) =>
    reply.code(202).send({ job: engine.startBuild(request.body ?? {}, request.scopes) }),
  );

  app.get('/v1/jobs/:id', (request) => {
    const { id } = request.params as { id: string };
    return { job: engine.getJob(id, request.scopes) };
  });

  app.post('/v1/jobs/:id/answers', (request) => {
    const { id } = request.params as { id: string };
    const { question_id: questionId, answer } = (request.body ?? {}) as Record<string, unknown>;
    if (typeof questionId !== 'string' || typeof answer !== 'string' || answer === '') {
      throw new ToolDropError('invalid_input', 'send {"question_id": "...", "answer": "..."}');
    }
    return { job: engine.answerQuestion(id, questionId, answer, request.scopes) };
  });

  // A recording may carry its network log as HAR, so it gets a larger body limit.
  app.post('/v1/recordings', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    const { id } = engine.saveRecording(request.body, request.scopes);
    return reply.code(201).send({ id });
  });

  app.post('/mcp', async (request, reply) => {
    reply.hijack();
    await handleMcpHttp(engine, request.raw, reply.raw, request.body, { scopes: request.scopes, version });
  });

  // Stateless Streamable HTTP has no server-to-client stream or sessions to end.
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({
      method,
      url: '/mcp',
      handler: async (_request, reply) =>
        reply
          .code(405)
          .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }),
    });
  }

  return app;
}

function authenticate(engine: Engine, request: FastifyRequest): Scopes {
  const key = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
  const record = key ? verifyApiKey(engine.db, key) : undefined;
  if (!record) {
    throw new ToolDropError(
      'unauthorized',
      'send an API key as "Authorization: Bearer <key>"; create one with `tooldrop keys create`',
    );
  }
  return record.scopes;
}

function describeTool(tool: PublishedTool) {
  return {
    name: tool.name,
    description: tool.description,
    authority: tool.authority,
    site: tool.site.origin,
    version: tool.version,
    status: tool.status,
    input_schema: tool.input_schema,
    output_schema: tool.output_schema,
  };
}

function toErrorJson(error: unknown): ToolDropErrorJson {
  if (error instanceof ToolDropError) return error.toJSON();
  // Fastify's own errors (bad JSON, wrong content type) are the caller's input.
  if (hasStatus(error) && error.statusCode < 500) return { code: 'invalid_input', message: error.message };
  return { code: 'internal', message: 'internal error' };
}

function hasStatus(error: unknown): error is { statusCode: number; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { statusCode?: unknown }).statusCode === 'number'
  );
}
