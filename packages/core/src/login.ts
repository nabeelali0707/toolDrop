import { z } from 'zod';

/** How a login gets its second factor, in order of preference (SPEC, Authentication). */
export const TWOFA_METHODS = ['totp', 'email', 'sms', 'human'] as const;
export const twofaMethodSchema = z.enum(TWOFA_METHODS);
export type TwofaMethod = z.infer<typeof twofaMethodSchema>;

/** How to find this login's code in an email or SMS. */
export const twofaConfigSchema = z.strictObject({
  /** Expected sender: an email address or phone number. */
  sender: z.string().min(1).optional(),
  /** Regular expression whose first group (or whole match) is the code. Default: the first 4 to 8 digit number. */
  code_pattern: z.string().min(1).optional(),
});
export type TwofaConfig = z.infer<typeof twofaConfigSchema>;

export const LOGIN_STATUSES = ['verified', 'needs_attention', 'unchecked'] as const;
export const loginStatusSchema = z.enum(LOGIN_STATUSES);
export type LoginStatus = z.infer<typeof loginStatusSchema>;

/** What `add_login` takes (SPEC, Management MCP tools). The values are sealed in the vault at once. */
export const addLoginSchema = z.strictObject({
  /** The site the login is for; any page of it. */
  site: z.url({ protocol: /^https?$/ }),
  username: z.string().min(1).max(500),
  password: z.string().min(1).max(500),
  /** A name to tell several logins for one site apart, e.g. "work account". */
  label: z.string().min(1).max(100).optional(),
  /** The authenticator secret, as base32, for sites with TOTP codes. */
  totp_secret: z
    .string()
    .regex(/^[A-Z2-7]+=*$/i, 'a base32 secret, as an authenticator app shows it')
    .min(16)
    .max(128)
    .optional(),
  /** How codes arrive when there is no TOTP secret: "human" asks you each time. */
  twofa: twofaMethodSchema.optional(),
});
export type AddLogin = z.infer<typeof addLoginSchema>;

/** A saved login as every API shows it: masked, never the values (SPEC, Vault). */
export interface LoginView {
  id: string;
  site: string;
  label: string;
  /** The username with most characters hidden, e.g. "fi••••er". */
  username: string;
  twofa: TwofaMethod | null;
  status: LoginStatus;
  created_at: string;
}
