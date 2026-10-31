import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { POLICY_OPERATORS, ToolDropError, type ApprovalView } from '@tooldrop/core';
import { openEngine } from '../home.ts';

// Safe mode in the terminal (SPEC, Safe mode): decide on writes waiting for
// approval, read the record of past ones, and set the policies that approve
// writes by themselves.

const APPROVALS_USAGE = `usage:
  tooldrop approvals [list] [--all]
  tooldrop approvals show <id> [--screenshot form.png]
  tooldrop approvals approve <id>
  tooldrop approvals reject <id>`;

/** `tooldrop approvals`: writes waiting for a decision, and the audit log with --all. */
export async function approvals(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { all: { type: 'boolean', default: false }, screenshot: { type: 'string' } },
  });
  const [action = 'list', id] = positionals;
  const { engine, close } = await openEngine({ backgroundHeals: false });
  try {
    if (action === 'list') {
      const shown = await engine.listApprovals(['*'], values.all ? undefined : 'pending');
      if (shown.length === 0)
        console.log(values.all ? 'No writes yet.' : 'No write is waiting for approval.');
      for (const approval of shown) {
        const decided = approval.decided_by ? ` by ${approval.decided_by}` : '';
        console.log(`${approval.id}  ${approval.tool}  ${approval.status}${decided}  ${approval.created_at}`);
      }
      return 0;
    }
    if (!id) throw new ToolDropError('invalid_input', APPROVALS_USAGE);
    if (action === 'show') {
      console.log(describeApproval(await engine.getApproval(id)));
      const png = values.screenshot ? await engine.approvalScreenshot(id, 'before') : undefined;
      if (values.screenshot && png) {
        writeFileSync(values.screenshot, png);
        console.log(`\nSaved the filled form to ${values.screenshot}.`);
      }
      return 0;
    }
    if (action === 'approve' || action === 'reject') {
      const decided = await engine.decideApproval(id, action, ['*'], 'cli');
      if (action === 'reject') {
        console.log(`Rejected ${id}. Nothing was changed.`);
        return 0;
      }
      console.log(`Approved ${id}. The write was made:\n`);
      console.log(
        typeof decided.result === 'string' ? decided.result : JSON.stringify(decided.result, null, 2),
      );
      return 0;
    }
    throw new ToolDropError('invalid_input', APPROVALS_USAGE);
  } finally {
    await close();
  }
}

/** A write's preview and decision, for the terminal. */
export function describeApproval(approval: ApprovalView): string {
  const lines = [
    `${approval.tool} (${approval.status}${approval.decided_by ? ` by ${approval.decided_by}` : ''})`,
    `  ${approval.preview.action}`,
    `  on ${approval.preview.url}`,
    ...approval.preview.fields.map((field) => `  ${field.field}: ${field.value}`),
  ];
  if (approval.status === 'pending') lines.push(`  Can be approved until ${approval.expires_at}.`);
  if (approval.outcome) {
    lines.push(
      approval.outcome.ok
        ? `  Done${approval.outcome.url ? `, ending on ${approval.outcome.url}` : ''}.`
        : `  Failed: ${approval.outcome.error?.message ?? 'unknown error'}`,
    );
  }
  return lines.join('\n');
}

const POLICIES_USAGE = `usage:
  tooldrop policies add <tool> --when "amount < 100"
  tooldrop policies list
  tooldrop policies remove <id>`;

const CONDITION = new RegExp(
  `^\\s*([A-Za-z_][\\w.]*)\\s*(${[...POLICY_OPERATORS].sort((a, b) => b.length - a.length).join('|')})\\s*(.+?)\\s*$`,
);

/** `tooldrop policies`: rules that approve a write tool's calls by themselves. */
export async function policies(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { when: { type: 'string' } },
  });
  const [action = 'list', target] = positionals;
  const { engine, close } = await openEngine({ backgroundHeals: false });
  try {
    if (action === 'list') {
      const all = await engine.listPolicies();
      if (all.length === 0) console.log('No policies: every write waits for an approval.');
      for (const policy of all) {
        console.log(`${policy.id}  ${policy.tool} when ${policy.field} ${policy.op} ${String(policy.value)}`);
      }
      return 0;
    }
    if (action === 'add' && target && values.when) {
      const match = CONDITION.exec(values.when);
      if (!match)
        throw new ToolDropError('invalid_input', `--when looks like "amount < 100"\n${POLICIES_USAGE}`);
      const [, field, op, raw = ''] = match;
      const text = raw.replace(/^(["'])(.*)\1$/, '$2');
      const value = /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
      const policy = await engine.createPolicy({ tool: target, field, op, value });
      console.log(
        `${target} now runs without asking when ${field} ${op} ${String(value)} (policy ${policy.id}).`,
      );
      return 0;
    }
    if (action === 'remove' && target) {
      await engine.deletePolicy(target);
      console.log(`Removed policy ${target}.`);
      return 0;
    }
    throw new ToolDropError('invalid_input', POLICIES_USAGE);
  } finally {
    await close();
  }
}
