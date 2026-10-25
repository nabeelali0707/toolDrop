import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateRecipeFolder, type RecipeFolder } from './recipe-library.ts';

/** The example recipe from the library, as a starting point for each case. */
function example(): RecipeFolder {
  const dir = new URL('../recipes/hn.algolia.com/hn_front_page/', import.meta.url);
  const files = Object.fromEntries(
    readdirSync(dir).map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]),
  );
  return { path: 'hn.algolia.com/hn_front_page', files };
}

/** The example with one JSON file changed. */
function withJson(file: string, change: (value: Record<string, unknown>) => unknown): RecipeFolder {
  const folder = example();
  const value = JSON.parse(folder.files[file] ?? '{}') as Record<string, unknown>;
  return { ...folder, files: { ...folder.files, [file]: JSON.stringify(change(value)) } };
}

const firstStep = (recipe: Record<string, unknown>) => (recipe.steps as Record<string, unknown>[])[0] ?? {};

describe('validateRecipeFolder', () => {
  it('accepts the example recipe', () => {
    expect(validateRecipeFolder(example())).toEqual([]);
  });

  it('reports every missing file', () => {
    const folder = example();
    delete folder.files['schema.json'];
    delete folder.files['README.md'];
    expect(validateRecipeFolder(folder)).toEqual(['missing schema.json', 'missing README.md']);
  });

  it('requires the folder to match the site host and tool name', () => {
    const folder = { ...example(), path: 'news.ycombinator.com/front_page' };
    expect(validateRecipeFolder(folder)).toEqual([
      'folder: must be recipes/hn.algolia.com/hn_front_page, found recipes/news.ycombinator.com/front_page',
    ]);
  });

  it('only accepts read-only recipes without sign-in', () => {
    const errors = validateRecipeFolder(withJson('manifest.json', (m) => ({ ...m, authority: 'write' })));
    expect(errors.some((error) => error.startsWith('manifest.json: authority:'))).toBe(true);
  });

  it('rejects literal credentials in headers', () => {
    const folder = withJson('recipe.json', (recipe) => {
      firstStep(recipe).headers = { Authorization: 'Bearer abc123' };
      return recipe;
    });
    expect(validateRecipeFolder(folder)).toEqual([
      'recipe.json: steps.0.headers.Authorization: looks like a credential; never commit one',
    ]);
  });

  it('rejects session references, since public recipes have no session', () => {
    const folder = withJson('recipe.json', (recipe) => {
      firstStep(recipe).headers = { Authorization: '{{session.token}}' };
      return recipe;
    });
    expect(validateRecipeFolder(folder)).toEqual([
      'recipe.json: {{session.token}}: community recipes are for public sites and have no session',
    ]);
  });

  it('keeps requests on the manifest site', () => {
    const folder = withJson('recipe.json', (recipe) => {
      firstStep(recipe).url = 'https://tracker.example.net/collect';
      return recipe;
    });
    expect(validateRecipeFolder(folder)).toEqual([
      'recipe.json: steps.0.url: may only reach https://hn.algolia.com; start it with {{site}}',
    ]);
  });

  it('requires {{input.*}} references to be declared in the input schema', () => {
    const folder = withJson('recipe.json', (recipe) => {
      firstStep(recipe).query = { tags: '{{input.section}}' };
      return recipe;
    });
    expect(validateRecipeFolder(folder)).toEqual([
      'recipe.json: {{input.section}} is not declared in schema.json input.properties',
    ]);
  });

  it('checks every test input against the input schema', () => {
    const folder = withJson('test-inputs.json', () => [{ limit: 5 }, { limit: 500 }]);
    expect(validateRecipeFolder(folder)).toEqual(['test-inputs.json[1]: /limit must be <= 50']);
  });

  it('rejects personal data in test inputs', () => {
    const folder = withJson('test-inputs.json', () => [
      { limit: 5 },
      { limit: 30, note: 'jane@example.com' },
    ]);
    expect(validateRecipeFolder(folder)).toContain(
      'test-inputs.json: contains an email address; recipes must hold no personal data',
    );
  });

  it('accepts the template, which has no real site folder', () => {
    const dir = new URL('../recipes/_template/', import.meta.url);
    const files = Object.fromEntries(
      readdirSync(dir).map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]),
    );
    expect(validateRecipeFolder({ path: '_template', files }, { template: true })).toEqual([]);
  });
});
