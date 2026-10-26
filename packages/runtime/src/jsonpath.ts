import { JSONPath } from 'jsonpath-plus';

// Recipes can come from the community library, so JSONPath never evaluates
// script or filter expressions (SPEC: never eval). Plain paths such as
// $.items[*].total.value cover what recipes need.

/** Every value the path matches, in document order. */
export function queryAll(json: unknown, path: string): unknown[] {
  return JSONPath({ path, json: json as object, wrap: true, eval: false }) as unknown[];
}

/** The first value the path matches, or undefined. */
export function queryOne(json: unknown, path: string): unknown {
  return queryAll(json, path)[0];
}
