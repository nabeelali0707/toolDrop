import { ToolDropError, type RankedSelector, type Selector, type Step } from '@tooldrop/core';
import type { Locator, Page } from 'playwright';
import type { BrowserPool } from '../browser/pool.ts';
import type { SiteLimiter } from '../limits.ts';
import { atStep, columnIndexes, describeTarget, mapPages } from '../steps.ts';
import { render, renderText, type TemplateContext } from '../templates.ts';

// Runs browser_script recipes in a warm Playwright context for the site.

export interface BrowserDeps {
  pool: BrowserPool;
  siteKey: string;
  limiter: SiteLimiter;
  /** How long the first selector of a target may wait for the page (default 10 s). */
  waitMs?: number;
}

type Role = Parameters<Page['getByRole']>[0];

export async function runBrowserRecipe(
  steps: Step[],
  context: TemplateContext,
  deps: BrowserDeps,
): Promise<unknown> {
  const browserContext = await deps.pool.context(deps.siteKey);
  return deps.limiter.run(async () => {
    const page = await browserContext.newPage();
    const settle = trackRequests(page);
    try {
      let result: unknown;
      for (const [index, step] of steps.entries()) {
        const value = await atStep(index, step, () =>
          step.op === 'map'
            ? Promise.resolve(mapPages([result], step))
            : runStep(page, step, context, deps.waitMs ?? 10_000, settle),
        );
        if (value !== undefined) {
          result = value;
          if ('save' in step && typeof step.save === 'string') context.vars[step.save] = value;
        }
      }
      return result;
    } finally {
      await page.close();
    }
  });
}

/** Runs one step; data steps return what they produced, others undefined. */
async function runStep(
  page: Page,
  step: Step,
  context: TemplateContext,
  waitMs: number,
  settle: () => Promise<void>,
): Promise<unknown> {
  const timeout = { timeout: waitMs };
  switch (step.op) {
    case 'goto': {
      const url = renderText(step.url, context);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', ...timeout });
      if (response && response.status() >= 400) {
        throw new ToolDropError('strategy_failed', `${url} answered ${response.status()}`, {
          details: { status: response.status() },
        });
      }
      await settle();
      return undefined;
    }
    case 'click': {
      if (!step.repeat) {
        await (await locate(page, step.target, 'visible', waitMs)).first().click(timeout);
        await settle();
        return undefined;
      }
      // "Load more": click while visible; not visible means nothing more to load.
      for (let clicks = 0; clicks < step.repeat.max; clicks++) {
        const button = await locateIfVisible(page, step.target);
        if (!button) break;
        await button.click(timeout);
        await settle();
      }
      return undefined;
    }
    case 'fill': {
      // An optional input the caller left out leaves the field alone.
      const value = render(step.value, context);
      if (value === undefined) return undefined;
      await (
        await locate(page, step.target, 'visible', waitMs)
      )
        .first()
        .fill(renderText(step.value, context), timeout);
      return undefined;
    }
    case 'select': {
      const value = render(step.value, context);
      if (value === undefined) return undefined;
      await (
        await locate(page, step.target, 'visible', waitMs)
      )
        .first()
        .selectOption(renderText(step.value, context), timeout);
      await settle();
      return undefined;
    }
    case 'wait_for':
      if (step.target) await locate(page, step.target, 'visible', step.timeout_ms ?? waitMs);
      if (step.url)
        await page.waitForURL(renderText(step.url, context), { timeout: step.timeout_ms ?? waitMs });
      return undefined;
    case 'extract_text': {
      const matches = await locate(page, step.target, 'attached', waitMs);
      const read = async (locator: Locator) =>
        (step.attribute
          ? await locator.getAttribute(step.attribute)
          : (await locator.textContent())?.trim()) ?? '';
      if (!step.all) return read(matches.first());
      return Promise.all((await matches.all()).map(read));
    }
    case 'extract_table': {
      const table = (await locate(page, step.target, 'visible', waitMs)).first();
      const { headers, rows } = await table.evaluate((element) => {
        // Typed structurally, so packages importing the runtime need no DOM types.
        const text = (cell: { textContent: string | null }) => (cell.textContent ?? '').trim();
        const headerRow = element.querySelector('thead tr') ?? element.querySelector('tr');
        const bodyRows =
          element.querySelectorAll('tbody tr').length > 0
            ? [...element.querySelectorAll('tbody tr')]
            : [...element.querySelectorAll('tr')].slice(1);
        return {
          headers: [...(headerRow?.querySelectorAll('th, td') ?? [])].map(text),
          rows: bodyRows.map((row) => [...row.querySelectorAll('td')].map(text)),
        };
      });
      const indexes = columnIndexes(headers, step.columns);
      return rows.map((cells) => {
        const out: Record<string, string> = {};
        for (const [field, index] of Object.entries(indexes)) out[field] = cells[index] ?? '';
        return out;
      });
    }
    default:
      throw new ToolDropError('internal', `"${step.op}" does not run in a browser`);
  }
}

/**
 * Tries a target's selectors in order and returns the first that matches,
 * as a locator for all of its matches. The first selector waits for the page;
 * the rest are quick checks. Falling back to a later selector is how a renamed
 * button keeps working without a heal.
 */
async function locate(
  page: Page,
  target: RankedSelector,
  state: 'visible' | 'attached',
  waitMs: number,
): Promise<Locator> {
  for (const [index, selector] of target.entries()) {
    const locator = toLocator(page, selector);
    try {
      await locator.first().waitFor({ state, timeout: index === 0 ? waitMs : 1_000 });
      return locator;
    } catch {
      // Try the next selector.
    }
  }
  throw new ToolDropError('strategy_failed', `no element matches ${describeTarget(target)}`);
}

/** The first selector of the target that is visible right now, without waiting. */
async function locateIfVisible(page: Page, target: RankedSelector): Promise<Locator | undefined> {
  for (const selector of target) {
    const locator = toLocator(page, selector).first();
    if (await locator.isVisible()) return locator;
  }
  return undefined;
}

/**
 * Returns a `settle()` that waits until the page's requests have finished and
 * the network has been quiet for a moment, so the next step sees what a click
 * or navigation loaded. Playwright's own "networkidle" state cannot do this:
 * once a page has reached it, it never waits again. Bounded, so a page that
 * never goes quiet does not stall the recipe.
 */
function trackRequests(page: Page, quietMs = 300, limitMs = 10_000): () => Promise<void> {
  let inFlight = 0;
  let changedAt = Date.now();
  page.on('request', () => {
    inFlight++;
    changedAt = Date.now();
  });
  const finished = () => {
    inFlight = Math.max(0, inFlight - 1);
    changedAt = Date.now();
  };
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);

  return async () => {
    const deadline = Date.now() + limitMs;
    // Give the action a moment to start its requests.
    await new Promise((resolve) => setTimeout(resolve, 50));
    while (Date.now() < deadline && (inFlight > 0 || Date.now() - changedAt < quietMs)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
}

function toLocator(page: Page, selector: Selector): Locator {
  switch (selector.kind) {
    case 'role':
      return page.getByRole(selector.role as Role, selector.name ? { name: selector.name } : {});
    case 'test_id':
      return page.getByTestId(selector.value);
    case 'text':
      return page.getByText(selector.value, selector.exact ? { exact: true } : {});
    case 'css':
      return page.locator(selector.value);
  }
}
