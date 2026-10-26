/** `tooldrop build`: arrives with the build pipeline (PLAN.md, Phase 2). */
export function build(): Promise<number> {
  console.error(
    [
      'Building a tool from a description arrives with the build pipeline (Phase 2 in PLAN.md).',
      'Today you can publish hand-written tools and community recipes:',
      '  tooldrop tools add <tool.json> --site <url>',
      '  tooldrop tools add <recipes/host/tool folder>',
    ].join('\n'),
  );
  return Promise.resolve(2);
}
