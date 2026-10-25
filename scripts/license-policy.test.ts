import { describe, expect, it } from 'vitest';
import { checkLicense, parseSpdx, type LicensePolicy } from './license-policy.ts';

const policy: LicensePolicy = {
  allowed: ['MIT', 'Apache-2.0', 'ISC'],
  reviewed: [{ package: 'caniuse-lite', license: 'CC-BY-4.0', reason: 'browser support data, not code' }],
};

const check = (license: string, name = 'some-package') => checkLicense({ name, license }, policy);

describe('checkLicense', () => {
  it('accepts an allowed license', () => {
    expect(check('MIT')).toEqual({ ok: true });
  });

  it('matches license ids case-insensitively', () => {
    expect(check('apache-2.0')).toEqual({ ok: true });
  });

  it('rejects a license that is not on the allowlist', () => {
    expect(check('GPL-3.0-only')).toMatchObject({ ok: false });
  });

  it('accepts OR when either side is allowed', () => {
    expect(check('(MIT OR GPL-3.0-only)')).toEqual({ ok: true });
  });

  it('rejects AND unless both sides are allowed', () => {
    expect(check('MIT AND GPL-3.0-only')).toMatchObject({ ok: false });
    expect(check('MIT AND ISC')).toEqual({ ok: true });
  });

  it('respects parentheses', () => {
    expect(check('(GPL-3.0-only OR MIT) AND ISC')).toEqual({ ok: true });
    expect(check('GPL-3.0-only OR (MIT AND AGPL-3.0-only)')).toMatchObject({ ok: false });
  });

  it('judges WITH by its base license', () => {
    expect(check('Apache-2.0 WITH LLVM-exception')).toEqual({ ok: true });
  });

  it('judges "or later" licenses by the named version', () => {
    expect(check('GPL-2.0+')).toMatchObject({ ok: false });
  });

  it('accepts a reviewed package only with the reviewed license', () => {
    expect(check('CC-BY-4.0', 'caniuse-lite')).toEqual({ ok: true });
    expect(check('CC-BY-4.0', 'other-data-package')).toMatchObject({ ok: false });
  });

  it.each(['UNKNOWN', 'UNLICENSED', 'SEE LICENSE IN LICENSE.md', '', '(MIT', 'MIT OR'])(
    'fails "%s" so it gets reviewed',
    (license) => {
      expect(check(license)).toMatchObject({ ok: false });
    },
  );
});

describe('parseSpdx', () => {
  it('gives AND higher precedence than OR', () => {
    expect(parseSpdx('MIT OR ISC AND Apache-2.0')).toEqual({
      kind: 'or',
      left: { kind: 'license', id: 'MIT' },
      right: {
        kind: 'and',
        left: { kind: 'license', id: 'ISC' },
        right: { kind: 'license', id: 'Apache-2.0' },
      },
    });
  });
});
