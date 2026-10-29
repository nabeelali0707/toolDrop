import { z } from 'zod';
import { stepSchema } from './recipe/schema.ts';
import { rankedSelectorSchema } from './recipe/selectors.ts';
import { collectTemplateRefs } from './recipe/templates.ts';

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
  /** How codes arrive when there is no TOTP secret: "sms" from your phone's forwarder, "human" asks you each time. */
  twofa: twofaMethodSchema.optional(),
  /** For codes by SMS or email: who sends them, and how to find the code in the message. */
  twofa_config: twofaConfigSchema.optional(),
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

// Login recipes (SPEC, Authentication): the browser steps that sign in to one
// site, ending in a signed-in state a check confirms. Values come only from
// the saved login, as {{input.username}}, {{input.password}} and {{input.otp}}.

export const LOGIN_INPUTS = ['username', 'password', 'otp'] as const;
const LOGIN_OPS = new Set(['goto', 'click', 'fill', 'select', 'wait_for']);

/** How toolDrop knows it is signed in. */
export const loginCheckSchema = z.discriminatedUnion('kind', [
  /** The page loads without landing on the sign-in page, and shows no password field. */
  z.strictObject({ kind: z.literal('page'), url: z.string().min(1) }),
  /** An element is visible on the page, such as the account menu. */
  z.strictObject({ kind: z.literal('element'), url: z.string().min(1), target: rankedSelectorSchema }),
]);
export type LoginCheck = z.infer<typeof loginCheckSchema>;

export const loginRecipeSchema = z
  .strictObject({
    /** The sign-in page, where a session that expired ends up. */
    url: z.string().min(1),
    steps: z.array(stepSchema).min(1).max(30),
    check: loginCheckSchema,
  })
  .superRefine((recipe, ctx) => {
    recipe.steps.forEach((step, index) => {
      if (!LOGIN_OPS.has(step.op)) {
        ctx.addIssue({
          code: 'custom',
          message: `a login step cannot "${step.op}"`,
          path: ['steps', index, 'op'],
        });
      }
      for (const ref of collectTemplateRefs(step).refs) {
        const allowed =
          ref.root === 'site' ||
          (ref.root === 'input' && (LOGIN_INPUTS as readonly string[]).includes(ref.path[0] ?? ''));
        if (!allowed) {
          ctx.addIssue({
            code: 'custom',
            message: `{{${ref.raw}}} is not a login value; use {{input.username}}, {{input.password}} or {{input.otp}}`,
            path: ['steps', index],
          });
        }
      }
    });
  });
export type LoginRecipe = z.infer<typeof loginRecipeSchema>;

/** Whether signing in asks for a one-time code. */
export function needsCode(recipe: LoginRecipe): boolean {
  return collectTemplateRefs(recipe.steps).refs.some((ref) => ref.root === 'input' && ref.path[0] === 'otp');
}

/** The inbox email codes are read from (SPEC, 2FA step 2), as `tooldrop email connect` takes it. */
export const connectMailboxSchema = z
  .strictObject({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535).default(993),
    /** TLS from the start; without it, STARTTLS when the server offers it. */
    secure: z.boolean().optional(),
    user: z.string().min(1).max(320),
    password: z.string().min(1).max(500),
  })
  .transform((mailbox) => ({ ...mailbox, secure: mailbox.secure ?? mailbox.port === 993 }));
export type ConnectMailbox = z.input<typeof connectMailboxSchema>;
