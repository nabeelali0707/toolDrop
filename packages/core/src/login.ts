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
