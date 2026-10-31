import {
  APPROVAL_STATUSES,
  JOB_KINDS,
  JOB_STATUSES,
  ToolDropError,
  type ApprovalStatus,
  type ErrorCode,
  type JobKind,
  type JobStatus,
  type ToolDropErrorJson,
} from '@tooldrop/core';
import { verifyApiKey, type PublishedTool } from '@tooldrop/db';
import { callInputSchema, type Engine, type Scopes } from '@tooldrop/engine';
import { handleMcpHttp } from '@tooldrop/mcp';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

// The REST API (SPEC, MCP and REST interfaces) and remote MCP. Every route but
// /health needs a bearer API key; `tooldrop keys create` makes one.

export interface ServerOptions {
  engine: Engine;
  /** toolDrop's version, for /health and MCP clients. */
  version?: string;
  /** The dashboard's static files, served at / next to the API (apps/dashboard). */
  dashboardDir?: string;
}

const STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  approval_required: 409,
  conflict: 409,
  human_needed: 409,
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
    /** Who is calling, for the write audit log: "api-key:<label>". */
    by: string;
    /** The body as sent, for routes that check a signature over it. */
    rawBody?: string;
  }
}

export function createServer({ engine, version = '0.0.0', dashboardDir }: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.decorateRequest('scopes', null as unknown as Scopes);
  app.decorateRequest('by', '');
  keepRawJson(app);

  app.addHook('onRequest', async (request) => {
    // The dashboard's pages are the same for everyone; what they show comes from the API, with a key.
    if (!needsKey(request.url)) return;
    const key = await authenticate(engine, request);
    request.scopes = key.scopes;
    request.by = `api-key:${key.label}`;
  });

  registerSmsRoute(app, engine);

  app.setErrorHandler(async (error, _request, reply) => {
    const json = toErrorJson(error);
    // Fastify's own client errors keep their status (400, 413, 415); ours map from the code.
    const status =
      !(error instanceof ToolDropError) && hasStatus(error) ? error.statusCode : STATUS[json.code];
    return reply.code(status).send({ error: json });
  });

  app.get('/health', () => ({ ok: true, version }));

  if (dashboardDir) {
    void app.register(fastifyStatic, { root: dashboardDir, prefix: '/', redirect: true });
  } else {
    app.get('/', (_request, reply) =>
      reply
        .type('text/html')
        .send(
          `<!doctype html><title>toolDrop</title><p>toolDrop ${version} is running: the REST API is at /v1 and MCP at /mcp. This installation has no dashboard; build it with <code>pnpm --filter @tooldrop/dashboard build</code>.</p>`,
        ),
    );
  }
  app.setNotFoundHandler((request, reply) =>
    needsKey(request.url)
      ? reply.code(404).send({
          error: { code: 'not_found', message: `no route ${request.method} ${request.url.split('?')[0]}` },
        })
      : reply
          .code(404)
          .type('text/html')
          .send(
            '<!doctype html><title>Not found</title><p>Not found. <a href="/">Open the dashboard</a></p>',
          ),
  );

  app.get('/v1/tools', async (request) => ({
    tools: (await engine.listTools(request.scopes)).map(describeTool),
  }));

  app.get('/v1/tools/:name', async (request) => {
    const { name } = request.params as { name: string };
    return { tool: describeTool(await engine.getTool(name, request.scopes)) };
  });

  // The run log: how each call went, never its result (SPEC, runs table).
  app.get('/v1/runs', async (request) => {
    const { tool, limit } = request.query as { tool?: string; limit?: string };
    return {
      runs: await engine.listRuns(request.scopes, { ...(tool && { tool }), limit: pageSize(limit) }),
    };
  });

  // Builds and heals, e.g. those waiting for an answer, such as a 2FA code.
  app.get('/v1/jobs', async (request) => {
    const { status, kind, limit } = request.query as { status?: string; kind?: string; limit?: string };
    if (status !== undefined && !(JOB_STATUSES as readonly string[]).includes(status)) {
      throw new ToolDropError('invalid_input', `status is one of ${JOB_STATUSES.join(', ')}`);
    }
    if (kind !== undefined && !(JOB_KINDS as readonly string[]).includes(kind)) {
      throw new ToolDropError('invalid_input', `kind is one of ${JOB_KINDS.join(', ')}`);
    }
    return {
      jobs: await engine.listJobs(request.scopes, {
        ...(status && { status: status as JobStatus }),
        ...(kind && { kind: kind as JobKind }),
        limit: pageSize(limit),
      }),
    };
  });

  app.post('/v1/tools/:name/run', async (request) => {
    const { name } = request.params as { name: string };
    const { result, meta } = await engine.runTool(name, request.body ?? {}, request.scopes);
    return { result, meta };
  });

  // A tool's history and heal log, and rollback (SPEC, Self-healing: versions kept for rollback).
  app.get('/v1/tools/:name/versions', async (request) => {
    const { name } = request.params as { name: string };
    return { versions: await engine.versions(name, request.scopes) };
  });

  app.post('/v1/tools/:name/rollback', async (request) => {
    const { name } = request.params as { name: string };
    const { version } = (request.body ?? {}) as { version?: unknown };
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      throw new ToolDropError('invalid_input', 'send {"version": <number>}');
    }
    return { tool: describeTool(await engine.rollback(name, version, request.scopes)) };
  });

  // Builds run as jobs: start one, poll it, answer its questions (SPEC, REST API).
  app.post('/v1/builds', async (request, reply) =>
    reply.code(202).send({ job: await engine.startBuild(request.body ?? {}, request.scopes) }),
  );

  app.get('/v1/jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { job: await engine.getJob(id, request.scopes) };
  });

  app.post('/v1/jobs/:id/answers', async (request) => {
    const { id } = request.params as { id: string };
    const { question_id: questionId, answer } = (request.body ?? {}) as Record<string, unknown>;
    if (typeof questionId !== 'string' || typeof answer !== 'string' || answer === '') {
      throw new ToolDropError('invalid_input', 'send {"question_id": "...", "answer": "..."}');
    }
    return { job: await engine.answerQuestion(id, questionId, answer, request.scopes) };
  });

  // Saved logins: sealed in the vault, shown masked (SPEC, add_login and list_logins).
  app.post('/v1/logins', async (request, reply) =>
    reply.code(201).send({ login: await engine.addLogin(request.body ?? {}, request.scopes) }),
  );

  app.get('/v1/logins', async (request) => {
    const { site } = request.query as { site?: string };
    return { logins: await engine.listLogins(request.scopes, site) };
  });

  // Watches: a read tool's changes, sent to a webhook (SPEC, create_watch and delete_watch).
  // The signing secret is in the answer to the POST, and never again.
  app.post('/v1/watches', async (request, reply) =>
    reply.code(201).send(await engine.createWatch(request.body ?? {}, request.scopes)),
  );

  app.get('/v1/watches', async (request) => ({ watches: await engine.listWatches(request.scopes) }));

  app.delete('/v1/watches/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await engine.deleteWatch(id, request.scopes);
    return reply.code(204).send();
  });

  // Safe mode: writes waiting for approval, and the record of every decision (SPEC, approve_action).
  app.get('/v1/approvals', async (request) => {
    const { status } = request.query as { status?: string };
    if (status !== undefined && !(APPROVAL_STATUSES as readonly string[]).includes(status)) {
      throw new ToolDropError('invalid_input', `status is one of ${APPROVAL_STATUSES.join(', ')}`);
    }
    return {
      approvals: await engine.listApprovals(request.scopes, status as ApprovalStatus | undefined),
    };
  });

  app.get('/v1/approvals/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { approval: await engine.getApproval(id, request.scopes) };
  });

  app.get('/v1/approvals/:id/screenshot', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { which = 'before' } = request.query as { which?: string };
    if (which !== 'before' && which !== 'after') {
      throw new ToolDropError('invalid_input', 'which is "before" or "after"');
    }
    const png = await engine.approvalScreenshot(id, which, request.scopes);
    if (!png) throw new ToolDropError('not_found', `approval ${id} has no ${which} screenshot`);
    return reply.type('image/png').send(png);
  });

  app.post('/v1/approvals/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { decision } = (request.body ?? {}) as { decision?: unknown };
    return engine.decideApproval(id, decision, request.scopes, request.by);
  });

  // Policies approve a write tool's calls by themselves, so only full-access keys manage them.
  app.post('/v1/policies', async (request, reply) =>
    reply.code(201).send({ policy: await engine.createPolicy(request.body ?? {}, request.scopes) }),
  );

  app.get('/v1/policies', async (request) => ({ policies: await engine.listPolicies(request.scopes) }));

  app.delete('/v1/policies/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await engine.deletePolicy(id, request.scopes);
    return reply.code(204).send();
  });

  // A recording may carry its network log as HAR, so it gets a larger body limit.
  app.post('/v1/recordings', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    const { id } = engine.saveRecording(request.body, request.scopes);
    return reply.code(201).send({ id });
  });

  app.post('/mcp', async (request, reply) => {
    reply.hijack();
    await handleMcpHttp(engine, request.raw, reply.raw, request.body, {
      scopes: request.scopes,
      by: request.by,
      version,
    });
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

/** API routes need a key; /health, the dashboard's files and the signed SMS webhook do not. */
function needsKey(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (path === SMS_ROUTE) return false;
  return path.startsWith('/v1/') || path === '/mcp' || path.startsWith('/mcp/');
}

const SMS_ROUTE = '/v1/sms/inbound';

/**
 * Forwarded SMS from the person's phone (SPEC, SMS codes). No API key: the
 * forwarder signs the body with the SMS secret, or sends it as a bearer token.
 */
function registerSmsRoute(app: FastifyInstance, engine: Engine): void {
  app.post(SMS_ROUTE, async (request, reply) => {
    const signature = request.headers['x-signature'];
    await engine.receiveSms(request.rawBody ?? '', {
      signature: Array.isArray(signature) ? signature[0] : signature,
      authorization: request.headers.authorization,
    });
    return reply.code(204).send();
  });
}

/** JSON bodies parsed as usual, with the raw text kept for signature checks. */
function keepRawJson(app: FastifyInstance): void {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = String(body);
    request.rawBody = text;
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(Object.assign(new Error('the body is not valid JSON'), { statusCode: 400 }), undefined);
    }
  });
}

/**
 * Only the SMS webhook, for the listener on the local network address: a
 * phone on the same network can reach it, and nothing else of toolDrop is
 * exposed there (SPEC: locally the server listens on loopback only).
 */
export function createSmsServer({ engine }: { engine: Engine }): FastifyInstance {
  const app = Fastify({ logger: false });
  keepRawJson(app);
  registerSmsRoute(app, engine);
  app.setErrorHandler(async (error, _request, reply) => {
    const json = toErrorJson(error);
    const status =
      !(error instanceof ToolDropError) && hasStatus(error) ? error.statusCode : STATUS[json.code];
    return reply.code(status).send({ error: json });
  });
  return app;
}

async function authenticate(
  engine: Engine,
  request: FastifyRequest,
): Promise<{ scopes: Scopes; label: string }> {
  const key = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '')?.[1];
  const record = key ? await verifyApiKey(engine.db, key) : undefined;
  if (!record) {
    throw new ToolDropError(
      'unauthorized',
      'send an API key as "Authorization: Bearer <key>"; create one with `tooldrop keys create`',
    );
  }
  return record;
}

/** A list's length from ?limit=, between 1 and 200 (default 50). */
function pageSize(limit: string | undefined): number {
  const n = Number(limit ?? 50);
  return Number.isInteger(n) ? Math.min(200, Math.max(1, n)) : 50;
}

function describeTool(tool: PublishedTool) {
  return {
    name: tool.name,
    description: tool.description,
    authority: tool.authority,
    site: tool.site.origin,
    version: tool.version,
    status: tool.status,
    input_schema: callInputSchema(tool),
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
