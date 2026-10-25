// Fails when any installed package (dev dependencies included) has a license
// outside license-policy.json. Run with `pnpm check:licenses`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkLicense, type LicensePolicy } from './license-policy.ts';

interface PnpmLicenseEntry {
  name: string;
  versions: string[];
  license: string;
}

const policy = JSON.parse(
  readFileSync(new URL('../license-policy.json', import.meta.url), 'utf8'),
) as LicensePolicy;

const report = JSON.parse(pnpm(['licenses', 'list', '--json'])) as Record<string, PnpmLicenseEntry[]>;
const packages = Object.values(report).flat();

const failures = packages.flatMap((pkg) => {
  const verdict = checkLicense(pkg, policy);
  return verdict.ok ? [] : [`${pkg.name}@${pkg.versions.join(', ')}: ${verdict.reason}`];
});

if (failures.length > 0) {
  console.error(`License check failed for ${failures.length} of ${packages.length} packages:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nReplace the package, or review it and add it to license-policy.json (see DECISIONS.md, D-002).',
  );
  process.exit(1);
}
console.log(`License check passed: ${packages.length} packages.`);

function pnpm(args: string[]): string {
  const options = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 } as const;
  // Under `pnpm run`, npm_execpath points at the running pnpm, which avoids
  // shell differences between Windows and POSIX.
  const execPath = process.env.npm_execpath;
  if (execPath && /\.[cm]?js$/.test(execPath)) {
    return execFileSync(process.execPath, [execPath, ...args], options);
  }
  return execFileSync('pnpm', args, { ...options, shell: process.platform === 'win32' });
}
