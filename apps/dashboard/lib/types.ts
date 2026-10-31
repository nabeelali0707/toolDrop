import type { JsonSchema } from '@tooldrop/core';

// What the REST API answers, typed from toolDrop's own packages.

export type { ApprovalView, AuditEvent, LoginView, WatchView } from '@tooldrop/core';
import type { VersionSummary } from '@tooldrop/db';
import type { Recipe } from '@tooldrop/core';

export type { VersionSummary } from '@tooldrop/db';
export type { JobView, RunView, ToolJobView, ToolStats } from '@tooldrop/engine';

/** One version with its recipe, as GET /v1/tools/:name/versions/:version answers. */
export type VersionDetails = VersionSummary & { recipe: Recipe };

/** A tool as GET /v1/tools describes it. */
export interface ToolSummary {
  name: string;
  description: string;
  authority: 'read' | 'write';
  site: string;
  version: number;
  status: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
}
