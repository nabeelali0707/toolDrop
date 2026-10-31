import { identifierSchema } from '@tooldrop/core';
import { fitPrompt } from '@tooldrop/llm';
import { z } from 'zod';
import { promptBudget, type ModelAccess } from '../generate/recipe.ts';
import type { CrawledPage } from './crawl.ts';

// URL-first discovery, step 2 (SPEC, Differentiating features): the reasoning
// model reads what the crawl found and proposes a catalog of tools to build,
// each with the page to start from and the task, as build_tool takes them.

export interface ToolCandidate {
  name: string;
  description: string;
  /** The task, as build_tool takes it. */
  task: string;
  /** The page to build from, absolute. */
  url: string;
  authority: 'read' | 'write';
  /** What a caller would choose, such as a status filter. */
  inputs: string[];
}

export const catalogSchema = z.strictObject({
  tools: z
    .array(
      z.strictObject({
        name: identifierSchema,
        description: z.string().min(10).max(300),
        task: z.string().min(10).max(300),
        url: z.string().min(1).max(2000),
        authority: z.enum(['read', 'write']),
        inputs: z.array(identifierSchema).max(8).default([]),
      }),
    )
    .max(15),
});

export const DISCOVER_SYSTEM = `You propose tools an AI agent could use on a website, from notes on its pages. Reply with JSON only:
{"tools":[{"name":"list_invoices","description":"...","task":"...","url":"/invoices","authority":"read","inputs":["status"]}]}
- One tool per useful job a person does on the site: list or search records, read one record, or fill in a form.
- name: snake_case, starting with a verb. description: what it returns or does, for an agent choosing tools. task: the job in one sentence, as a person would ask for it.
- url: the page to start from, one of the pages in the notes.
- authority: "write" when the tool would submit a form that changes data (pay, create, update, send), else "read".
- inputs: what the caller would choose, such as a filter or a search term.
- Propose only what the notes show the site can do. At most 10 tools; fewer is fine.`;

/** Proposes tools from a crawl. Candidates outside the site, and repeated names, are left out. */
export async function proposeTools(
  access: ModelAccess,
  site: string,
  pages: CrawledPage[],
): Promise<ToolCandidate[]> {
  const prompt = fitPrompt(
    'discover',
    (level) => (level < 3 ? discoverPrompt(site, pages, level) : undefined),
    promptBudget(access, DISCOVER_SYSTEM),
  );
  const catalog = await access.llm.generateJson({
    role: 'reasoning',
    purpose: 'discover',
    schema: catalogSchema,
    system: DISCOVER_SYSTEM,
    prompt,
    ...(access.jobId !== undefined && { job_id: access.jobId }),
    ...(access.masker && { masker: access.masker }),
  });
  const names = new Set<string>();
  const candidates: ToolCandidate[] = [];
  for (const tool of catalog.tools) {
    let url: URL;
    try {
      url = new URL(tool.url, site);
    } catch {
      continue;
    }
    if (url.origin !== site || names.has(tool.name)) continue;
    names.add(tool.name);
    candidates.push({ ...tool, url: url.href });
  }
  return candidates;
}

/** The crawl as notes, shorter at each level: fewer pages, links and fields. */
export function discoverPrompt(site: string, pages: CrawledPage[], level = 0): string {
  const maxPages = [12, 8, 5][level] ?? 5;
  const maxLinks = [12, 6, 0][level] ?? 0;
  const notes = pages.slice(0, maxPages).map((page) => {
    const lines = [`Page ${page.url} "${page.title}"`];
    if (page.headings.length > 0) lines.push(`  headings: ${page.headings.join(' | ')}`);
    for (const table of page.tables) {
      lines.push(`  table: ${table.columns.join(', ')} (${table.rows} rows shown)`);
    }
    for (const form of page.forms) {
      const fields = form.fields
        .map((field) => {
          const options = field.options ? ` (${field.options.join(', ')})` : '';
          return `${field.label ?? field.name} [${field.type}${field.name ? ` ${field.name}` : ''}]${options}`;
        })
        .join('; ');
      lines.push(
        `  form ${form.method.toUpperCase()} ${form.action}${form.submit ? ` "${form.submit}"` : ''}: ${fields || 'no fields'}`,
      );
    }
    for (const api of page.apis) lines.push(`  loads JSON: ${api.method} ${api.path} → ${api.shape}`);
    if (maxLinks > 0 && page.links.length > 0) {
      lines.push(
        `  links: ${page.links
          .slice(0, maxLinks)
          .map((link) => `${link.text || '(no text)'} → ${link.url}`)
          .join('; ')}`,
      );
    }
    return lines.join('\n');
  });
  return `Site: ${site}\n\n${notes.join('\n\n')}\n\nPropose the tools.`;
}
