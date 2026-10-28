import {
  toolFileSchema,
  ToolDropError,
  type Authority,
  type Recording,
  type Strategy,
  type ToolFile,
} from '@tooldrop/core';
import { Masker, type Llm } from '@tooldrop/llm';
import type { RateLimit, Runtime, StorageState } from '@tooldrop/runtime';
import type { Browser } from 'playwright';
import type { Capture } from './capture/capture.ts';
import { collectSecrets } from './capture/har.ts';
import { explore } from './explore/agent.ts';
import type { TaskContext } from './generate/prompts.ts';
import { clarify, resolveLeftovers } from './generate/questions.ts';
import { assembleRecipe, writeRecipe, type ModelAccess } from './generate/recipe.ts';
import {
  describeSchemas,
  describeTool,
  inferOutputSchema,
  inputSchema,
  uniqueToolName,
} from './generate/schemas.ts';
import { planStrategies, type StrategyPlan } from './generate/strategy.ts';
import { replayRecording } from './recording/replay.ts';
import { inputSets, validateTwice } from './validate/double.ts';

// The build pipeline (SPEC, Build pipeline steps 3 to 9): capture, analyze,
// clarify, generate, infer schemas and validate twice. Finding an existing
// tool (step 1) and publishing (step 10) belong to the engine, which also
// stores the job; signing in (step 2) arrives with Phase 3.

export interface BuildRequest {
  url: string;
  task: string;
  authority: Authority;
  inputs_hint?: string;
  recording?: Recording;
}

export interface BuildDeps {
  llm: Llm;
  runtime: Runtime;
  /** A running browser to capture with; one is launched when absent. */
  browser?: Browser;
  jobId?: string;
  /** Whether a tool name is already published. */
  nameTaken: (name: string) => boolean;
  /** Request rate for validation runs; the site's default when absent. */
  rateLimit?: RateLimit;
  /** How long capture steps wait for the page. */
  waitMs?: number;
  /** A signed-in session for the site (SPEC, Build pipeline step 2), and its sign-in page. */
  signedIn?: { loginUrl: string; state: StorageState };
  /** Values every prompt masks, such as the saved login's username and password. */
  secrets?: string[];
  /** Most explore actions (default 30). */
  actionBudget?: number;
}

export interface BuildHooks {
  /** What the build is doing now, for get_job. */
  step(name: string): void;
  /** Asks the caller and waits for the answer (SPEC, Build pipeline step 4). */
  ask(question: { text: string; options?: string[] }): Promise<string>;
  /** Loads a recording the caller names in an answer. */
  recording(id: string): Recording;
  /** Receives the capture, to keep it in the data directory. */
  captured?(capture: Capture, masker: Masker): void;
}

export interface BuildResult {
  tool: ToolFile;
  site: string;
  /** The input sets that passed validation, kept for health checks and heals. */
  test_inputs: Record<string, unknown>[];
  /** The first rows the tool returned, to show the caller. */
  sample: unknown;
  strategy: Strategy;
  capture_id: string;
  attempts: number;
}

/** Most generate-and-validate attempts (SPEC, Build pipeline step 9). */
export const MAX_ATTEMPTS = 3;

export const RECORDING_QUESTION =
  'toolDrop could not find the data by exploring the site. Record the task once with `tooldrop record <url>` (or the Chrome extension), then answer with the recording ID.';

export async function buildTool(
  request: BuildRequest,
  deps: BuildDeps,
  hooks: BuildHooks,
): Promise<BuildResult> {
  if (request.authority === 'write') {
    throw new ToolDropError(
      'invalid_input',
      'write tools need safe mode, which arrives with Phase 4; build a read tool',
    );
  }
  const site = new URL(request.url).origin;
  const masker = new Masker();
  for (const secret of deps.secrets ?? []) masker.add(secret);
  const access: ModelAccess = {
    llm: deps.llm,
    masker,
    ...(deps.jobId !== undefined && { jobId: deps.jobId }),
  };
  const context: TaskContext = {
    task: request.task,
    site,
    answers: [],
    ...(request.inputs_hint !== undefined && { inputsHint: request.inputs_hint }),
  };
  const captureOptions = {
    ...(deps.browser && { browser: deps.browser }),
    ...(deps.waitMs !== undefined && { waitMs: deps.waitMs }),
    ...(deps.signedIn && { storageState: deps.signedIn.state }),
  };

  // Step 3: replay the recording, or explore; if exploring fails, ask for a recording.
  hooks.step('capturing');
  let capture: Capture;
  if (request.recording) {
    capture = await replayRecording(request.recording, captureOptions);
  } else {
    const explored = await explore(access, context, request.url, {
      ...captureOptions,
      ...(deps.actionBudget !== undefined && { budget: deps.actionBudget }),
    });
    if ('capture' in explored) {
      capture = explored.capture;
    } else {
      const id = (await hooks.ask({ text: `${RECORDING_QUESTION} (${explored.gaveUp})` })).trim();
      hooks.step('capturing');
      capture = await replayRecording(hooks.recording(id), captureOptions);
    }
  }
  collectSecrets(capture.exchanges, masker);
  hooks.captured?.(capture, masker);
  if (!capture.target) {
    throw new ToolDropError('invalid_input', 'the capture does not mark the data the tool returns');
  }

  // Steps 5 and 6: analyze the traffic, and plan the strategies that can work.
  hooks.step('analyzing traffic');
  const plans = await resolveLeftovers(access, context, planStrategies(capture, site));

  // Step 4: ask when the task is ambiguous.
  hooks.step('checking the task');
  for (const question of await clarify(access, context, capture, plans)) {
    context.answers.push({ question: question.text, answer: await hooks.ask(question) });
  }

  // Steps 7 to 9: write, check and validate, moving to the next strategy after a second failure.
  const sets = inputSets(capture);
  const inputs = inputSchema(capture);
  let problem: string | undefined;
  for (const [index, plan] of attemptOrder(plans).entries()) {
    const attempt = index + 1;
    hooks.step(`writing the ${plan.strategy} recipe (attempt ${attempt} of ${MAX_ATTEMPTS})`);
    let assembled: ReturnType<typeof assembleRecipe>;
    let first: unknown;
    try {
      const primary = await writeRecipe(access, context, capture, plan, problem);
      assembled = assembleRecipe(primary, capture, site, plan.draft.bindings);
      hooks.step(`validating the ${plan.strategy} recipe (attempt ${attempt} of ${MAX_ATTEMPTS})`);
      first = (
        await deps.runtime.run(
          {
            name: 'build',
            authority: 'read',
            input_schema: inputs,
            output_schema: {},
            version: 0,
            recipe: { strategy: primary.strategy, steps: primary.steps },
            site,
            ...(deps.rateLimit && { rate_limit: deps.rateLimit }),
            ...(deps.signedIn && { login: { url: deps.signedIn.loginUrl } }),
          },
          sets[0] ?? {},
        )
      ).result;
    } catch (error) {
      if (error instanceof ToolDropError && error.code.startsWith('llm_')) throw error;
      problem = error instanceof Error ? error.message : String(error);
      continue;
    }

    const { recipe, bindings } = assembled;
    const fallbackFields = recipe.fallback
      ? bindings.filter((binding) => binding.header).map((binding) => binding.field)
      : bindings.map((binding) => binding.field);
    const output = inferOutputSchema(first, fallbackFields);
    const report = await validateTwice(
      deps.runtime,
      {
        name: 'build',
        input_schema: inputs,
        output_schema: output,
        recipe,
        site,
        ...(deps.rateLimit && { rate_limit: deps.rateLimit }),
        ...(deps.signedIn && { login: { url: deps.signedIn.loginUrl } }),
      },
      sets,
    );
    if (!report.ok) {
      problem = report.problem;
      continue;
    }

    // Step 8: names and descriptions an agent reads.
    hooks.step('describing the tool');
    const description = await describeTool(access, context, capture, first);
    const schemas = describeSchemas(inputs, output, description);
    const tool = toolFileSchema.parse({
      name: uniqueToolName(description.name, deps.nameTaken),
      description: description.description,
      authority: 'read',
      input_schema: schemas.input,
      output_schema: schemas.output,
      recipe,
    });
    return {
      tool,
      site,
      test_inputs: sets,
      sample: Array.isArray(first) ? first.slice(0, 3) : first,
      strategy: recipe.strategy,
      capture_id: capture.id,
      attempts: attempt,
    };
  }
  throw new ToolDropError(
    'strategy_failed',
    `no recipe passed validation after ${MAX_ATTEMPTS} attempts: ${problem ?? 'no strategy fits this capture'}`,
  );
}

/**
 * Which plan each attempt uses: the cheapest twice, the second time with the
 * error, then the next one (SPEC: loop back to step 6, at most 3 times).
 */
export function attemptOrder(plans: StrategyPlan[]): StrategyPlan[] {
  const [first, second] = plans;
  if (!first) return [];
  return [first, first, second ?? first].slice(0, MAX_ATTEMPTS);
}
