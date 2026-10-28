// Builds the published `tooldrop` package: one bundled file for the CLI and
// every @tooldrop/* workspace package, with third-party packages left as
// regular npm dependencies. Node does not strip types inside node_modules,
// so the package must ship plain JavaScript (DECISIONS.md, D-032).
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const pkg = JSON.parse(readFileSync(here('./package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};
const dependencies = Object.keys(pkg.dependencies ?? {});

rmSync(here('./dist'), { recursive: true, force: true });
const result = await build({
  entryPoints: [here('./src/main.ts')],
  outfile: here('./dist/tooldrop.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  banner: { js: '#!/usr/bin/env node' },
  external: dependencies.flatMap((name) => [name, `${name}/*`]),
  metafile: true,
  logLevel: 'warning',
});

// Every package the bundle imports must be a dependency, or `npx tooldrop`
// fails on the user's machine instead of here.
const packageOf = (path: string) =>
  path
    .split('/')
    .slice(0, path.startsWith('@') ? 2 : 1)
    .join('/');
const imported = new Set(
  Object.values(result.metafile.outputs).flatMap((output) =>
    output.imports.filter((entry) => entry.external).map((entry) => packageOf(entry.path)),
  ),
);
const builtins = new Set(builtinModules);
const missing = [...imported].filter(
  (name) => !name.startsWith('node:') && !builtins.has(name) && !dependencies.includes(name),
);
if (missing.length > 0) {
  console.error(
    `The bundle imports packages missing from apps/cli/package.json dependencies: ${missing.join(', ')}`,
  );
  process.exit(1);
}

// Files the package needs next to the bundle: the migrations, and the
// dashboard's static pages, which `tooldrop serve` serves (apps/dashboard).
cpSync(here('../../packages/db/migrations'), here('./migrations'), { recursive: true });
pnpm(['--filter', '@tooldrop/dashboard', 'build']);
rmSync(here('./dashboard'), { recursive: true, force: true });
cpSync(here('../dashboard/out'), here('./dashboard'), { recursive: true });
cpSync(here('../../LICENSE'), here('./LICENSE'));
cpSync(here('../../README.md'), here('./README.md'));

const size = (readFileSync(here('./dist/tooldrop.js')).length / 1024).toFixed(0);
console.log(
  `Built dist/tooldrop.js (${size} KiB); external dependencies: ${[...imported].sort().join(', ')}`,
);

/** Runs pnpm: the one running this script when there is one, which avoids shell differences. */
function pnpm(args: string[]): void {
  const execPath = process.env.npm_execpath;
  if (execPath && /\.[cm]?js$/.test(execPath)) {
    execFileSync(process.execPath, [execPath, ...args], { stdio: 'inherit' });
  } else {
    execFileSync('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  }
}
