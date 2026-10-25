// Validates every recipe in recipes/ (DECISIONS.md, D-028). Run with
// `pnpm check:recipes`; CI runs it on every push and pull request.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecipeFolder, type RecipeFolder } from './recipe-library.ts';

const root = fileURLToPath(new URL('../recipes', import.meta.url));

const directories = (path: string) =>
  readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory());

function readFolder(path: string): RecipeFolder {
  const dir = join(root, path);
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isFile()) files[name] = readFileSync(file, 'utf8');
  }
  return { path, files };
}

const folders: { folder: RecipeFolder; template: boolean }[] = [];
if (existsSync(join(root, '_template'))) folders.push({ folder: readFolder('_template'), template: true });
for (const site of directories(root).filter((name) => name !== '_template')) {
  for (const tool of directories(join(root, site))) {
    folders.push({ folder: readFolder(`${site}/${tool}`), template: false });
  }
}

let failed = 0;
for (const { folder, template } of folders) {
  const errors = validateRecipeFolder(folder, { template });
  if (errors.length === 0) continue;
  failed++;
  console.error(`recipes/${folder.path}:`);
  for (const error of errors) console.error(`  - ${error}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${folders.length} recipes failed. See recipes/README.md for the format.`);
  process.exit(1);
}
console.log(`Recipe check passed: ${folders.length} recipes.`);
