import type { Strategy } from '@tooldrop/core';
import { classifyRequest, type RequestAnalysis } from '../analyze/classify.ts';
import {
  MIN_SCORE,
  rankExchanges,
  type Candidate,
  type HtmlCandidate,
  type JsonCandidate,
} from '../analyze/rank.ts';
import type { Capture } from '../capture/capture.ts';
import { browserDraft, htmlDraft, jsonDraft, type Draft } from './draft.ts';

// The strategies a capture supports, cheapest first (SPEC, Build pipeline
// step 6): replay the site's JSON API, fetch its HTML, or drive a browser.
// Builds detect `http_replay` for every API in the site's traffic;
// `official_api` is for recipes written against documented APIs.

export interface StrategyPlan {
  strategy: Strategy;
  draft: Draft;
  candidate?: Candidate;
  analysis?: RequestAnalysis;
}

export function planStrategies(capture: Capture, site: string): StrategyPlan[] {
  const plans: StrategyPlan[] = [];
  const candidates = rankExchanges(capture);

  const json = candidates.find(
    (c): c is JsonCandidate => c.kind === 'json' && c.score >= MIN_SCORE && c.columns.length > 0,
  );
  if (json) {
    const analysis = classifyRequest(capture, json.exchange, json.items);
    if (analysis.blockers.length === 0) {
      plans.push({
        strategy: 'http_replay',
        draft: jsonDraft(json, analysis, site),
        candidate: json,
        analysis,
      });
    }
  }

  const html = candidates.find((c): c is HtmlCandidate => c.kind === 'html' && c.score >= MIN_SCORE);
  if (html) {
    const analysis = classifyRequest(capture, html.exchange);
    const draft = htmlDraft(capture, html, analysis, site);
    if (draft && analysis.blockers.length === 0) {
      plans.push({ strategy: 'html_fetch', draft, candidate: html, analysis });
    }
  }

  if (capture.target) plans.push({ strategy: 'browser_script', draft: browserDraft(capture, site) });
  return plans;
}
