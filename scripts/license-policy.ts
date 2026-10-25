// License policy for the zero-cost rule (DECISIONS.md, D-002).
//
// A package passes when its SPDX expression is satisfied by the allowlist, or
// when the exact package + license pair has been reviewed and recorded in
// license-policy.json. `A OR B` passes if either side passes; `A AND B` needs
// both. Anything that does not parse (e.g. "UNKNOWN", "SEE LICENSE IN ...")
// fails, so it gets a human look.

export interface ReviewedLicense {
  package: string;
  license: string;
  reason: string;
}

export interface LicensePolicy {
  allowed: string[];
  reviewed: ReviewedLicense[];
}

export interface PackageLicense {
  name: string;
  license: string;
}

export type LicenseVerdict = { ok: true } | { ok: false; reason: string };

type Expr = { kind: 'license'; id: string } | { kind: 'and' | 'or'; left: Expr; right: Expr };

export function checkLicense(pkg: PackageLicense, policy: LicensePolicy): LicenseVerdict {
  const reviewed = policy.reviewed.some((r) => r.package === pkg.name && r.license === pkg.license);
  if (reviewed) return { ok: true };

  let expr: Expr;
  try {
    expr = parseSpdx(pkg.license);
  } catch (error) {
    return { ok: false, reason: `unparseable license "${pkg.license}": ${(error as Error).message}` };
  }

  const allowed = new Set(policy.allowed.map((id) => id.toLowerCase()));
  if (satisfies(expr, allowed)) return { ok: true };
  return { ok: false, reason: `license "${pkg.license}" is not on the allowlist` };
}

function satisfies(expr: Expr, allowed: Set<string>): boolean {
  switch (expr.kind) {
    case 'license':
      return allowed.has(expr.id.toLowerCase());
    case 'and':
      return satisfies(expr.left, allowed) && satisfies(expr.right, allowed);
    case 'or':
      return satisfies(expr.left, allowed) || satisfies(expr.right, allowed);
  }
}

const LICENSE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*\+?$/;

/** Parses an SPDX license expression such as `(MIT OR Apache-2.0) AND BSD-3-Clause`. */
export function parseSpdx(expression: string): Expr {
  const tokens = expression.replace(/[()]/g, ' $& ').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error('empty expression');
  let pos = 0;

  const peekKeyword = (): string | undefined => tokens[pos]?.toUpperCase();

  const parseOr = (): Expr => {
    let left = parseAnd();
    while (peekKeyword() === 'OR') {
      pos++;
      left = { kind: 'or', left, right: parseAnd() };
    }
    return left;
  };

  const parseAnd = (): Expr => {
    let left = parseAtom();
    while (peekKeyword() === 'AND') {
      pos++;
      left = { kind: 'and', left, right: parseAtom() };
    }
    return left;
  };

  const parseAtom = (): Expr => {
    const token = tokens[pos++];
    if (token === undefined) throw new Error('unexpected end of expression');
    if (token === '(') {
      const inner = parseOr();
      if (tokens[pos++] !== ')') throw new Error('missing ")"');
      return inner;
    }
    if (!LICENSE_ID.test(token) || ['AND', 'OR', 'WITH'].includes(token.toUpperCase())) {
      throw new Error(`unexpected "${token}"`);
    }
    // An exception (e.g. "Apache-2.0 WITH LLVM-exception") only adds permissions,
    // so the base license decides.
    if (peekKeyword() === 'WITH') {
      pos++;
      const exception = tokens[pos++];
      if (exception === undefined || !LICENSE_ID.test(exception)) {
        throw new Error('missing exception after WITH');
      }
    }
    // "GPL-2.0+" means "this version or later"; judge it by the named version.
    return { kind: 'license', id: token.replace(/\+$/, '') };
  };

  const expr = parseOr();
  if (pos !== tokens.length) throw new Error(`unexpected "${tokens[pos]}"`);
  return expr;
}
