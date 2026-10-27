import { generate } from 'otplib';

/** The current code for an authenticator secret (SPEC, 2FA: TOTP via otplib). */
export function totpCode(secret: string): Promise<string> {
  return generate({ secret });
}
