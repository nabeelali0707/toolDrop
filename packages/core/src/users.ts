import { z } from 'zod';

// Users, roles and the audit log of self-hosted toolDrop (SPEC, Self-hosting:
// multi-user, roles, audit logs; DECISIONS.md, D-057). Roles say which
// actions a user's API keys may take; a key's scopes still say which tools.

/** viewer: sees everything and runs read tools; editor: builds, runs and approves; admin: also logins, policies and the audit log. */
export const ROLES = ['viewer', 'editor', 'admin'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/** Whether `role` may do what `needed` may: each role may do all the roles before it may. */
export function roleAllows(role: Role, needed: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(needed);
}

/** A user as the CLI and the API show one. */
export interface UserView {
  name: string;
  role: Role;
  created_at: string;
}

/** One entry of the audit log: who did what, when, and how it went. Never a request's body. */
export interface AuditEvent {
  id: string;
  /** "user:alice", or "api-key:<label>" for a key of no user. */
  actor: string;
  /** "POST /v1/builds" over REST, "mcp build_tool" over remote MCP. */
  action: string;
  /** What it was done to, such as a tool's name or a job's ID. */
  target: string | null;
  /** The HTTP status, or 200 / 400 for an MCP call that worked or failed. */
  status: number | null;
  created_at: string;
}
