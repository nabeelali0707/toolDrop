import { ToolDropError } from '@tooldrop/core';
import { queryOne } from './jsonpath.ts';

// A small, safe language for pagination stop conditions such as
// `$.hasMore == false` or `$.meta.page >= $.meta.totalPages`. It compares JSON
// values and never evaluates code.
//
//   expr    := and ('||' and)*
//   and     := compare ('&&' compare)*
//   compare := operand (('==' | '!=' | '<' | '<=' | '>' | '>=') operand)?
//   operand := jsonpath | number | 'string' | "string" | true | false | null | '(' expr ')'
//
// A path that matches nothing counts as null.

type Token = { kind: 'path' | 'literal' | 'op' | 'paren'; value: unknown; text: string };

const OPERATORS = ['==', '!=', '<=', '>=', '<', '>', '&&', '||'];

export function evaluateCondition(expression: string, json: unknown): boolean {
  const tokens = tokenize(expression);
  let pos = 0;

  const fail = (message: string): never => {
    throw new ToolDropError('internal', `invalid condition "${expression}": ${message}`);
  };

  const parseOr = (): unknown => {
    let left = parseAnd();
    while (tokens[pos]?.text === '||') {
      pos++;
      const right = parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  };

  const parseAnd = (): unknown => {
    let left = parseCompare();
    while (tokens[pos]?.text === '&&') {
      pos++;
      const right = parseCompare();
      left = truthy(left) && truthy(right);
    }
    return left;
  };

  const parseCompare = (): unknown => {
    const left = parseOperand();
    const op = tokens[pos];
    if (op?.kind !== 'op' || op.text === '&&' || op.text === '||') return left;
    pos++;
    return compare(left, op.text, parseOperand());
  };

  const parseOperand = (): unknown => {
    const token = tokens[pos++];
    if (!token) return fail('unexpected end');
    if (token.kind === 'path') return queryOne(json, token.text) ?? null;
    if (token.kind === 'literal') return token.value;
    if (token.text === '(') {
      const inner = parseOr();
      if (tokens[pos++]?.text !== ')') fail('missing ")"');
      return inner;
    }
    return fail(`unexpected "${token.text}"`);
  };

  const result = parseOr();
  if (pos !== tokens.length) fail(`unexpected "${tokens[pos]?.text}"`);
  return truthy(result);
}

function compare(left: unknown, op: string, right: unknown): boolean {
  if (op === '==') return same(left, right);
  if (op === '!=') return !same(left, right);
  if (typeof left === 'number' && typeof right === 'number') {
    if (op === '<') return left < right;
    if (op === '<=') return left <= right;
    if (op === '>') return left > right;
    return left >= right;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    if (op === '<') return left < right;
    if (op === '<=') return left <= right;
    if (op === '>') return left > right;
    return left >= right;
  }
  return false;
}

function same(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false && value !== 0 && value !== '';
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expression.length) {
    const char = expression[i] ?? '';
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    const op = OPERATORS.find((candidate) => expression.startsWith(candidate, i));
    if (op) {
      tokens.push({ kind: 'op', value: op, text: op });
      i += op.length;
    } else if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', value: char, text: char });
      i++;
    } else if (char === '$') {
      // A path runs to the next space, operator or closing paren; [...] may hold anything.
      let end = i + 1;
      let depth = 0;
      while (end < expression.length) {
        const c = expression[end] ?? '';
        if (c === '[') depth++;
        if (c === ']') depth--;
        if (
          depth === 0 &&
          (/\s/.test(c) || c === ')' || OPERATORS.some((o) => expression.startsWith(o, end)))
        )
          break;
        end++;
      }
      const text = expression.slice(i, end);
      tokens.push({ kind: 'path', value: text, text });
      i = end;
    } else if (char === '"' || char === "'") {
      const end = expression.indexOf(char, i + 1);
      if (end < 0) throw new ToolDropError('internal', `invalid condition "${expression}": unclosed string`);
      const text = expression.slice(i, end + 1);
      tokens.push({ kind: 'literal', value: expression.slice(i + 1, end), text });
      i = end + 1;
    } else {
      const match = /^(-?\d+(?:\.\d+)?|true|false|null)/.exec(expression.slice(i));
      if (!match?.[1])
        throw new ToolDropError('internal', `invalid condition "${expression}": unexpected "${char}"`);
      const text = match[1];
      const value = text === 'true' ? true : text === 'false' ? false : text === 'null' ? null : Number(text);
      tokens.push({ kind: 'literal', value, text });
      i += text.length;
    }
  }
  return tokens;
}
