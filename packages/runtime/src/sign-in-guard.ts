import { ToolDropError } from '@tooldrop/core';
import type { Page } from 'playwright';

// What a sign-in may do on its own (SPEC, Authentication): type a login only
// on the site's own origin or an identity provider the person allowed, and
// never solve a captcha (DECISIONS.md, D-018). Either case stops and asks a
// person, with an error that says what to do.

/** The widgets of the common captcha services, and the attribute they share. */
const CAPTCHA = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha.com"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '[data-sitekey]',
].join(', ');

export async function hasCaptcha(page: Page): Promise<boolean> {
  return (await page.locator(CAPTCHA).count()) > 0;
}

/** Fails when the page may not receive the login: another origin not allowed, or a captcha. */
export async function guardSignIn(page: Page, site: string, approved: readonly string[]): Promise<void> {
  const origin = new URL(page.url()).origin;
  if (origin !== site && !approved.includes(origin)) {
    throw new ToolDropError(
      'human_needed',
      `signing in to ${site} goes through ${origin}, another site. Allow it once, for example with \`tooldrop logins verify ${site}\`, and toolDrop types the saved login there.`,
      { details: { approve_origin: origin } },
    );
  }
  if (await hasCaptcha(page)) throw signInByHand(site, 'shows a captcha, which toolDrop never solves');
}

/** A site where a person has to sign in: past a captcha, or because they did so before. */
export function signInByHand(site: string, why: string): ToolDropError {
  return new ToolDropError(
    'human_needed',
    `signing in to ${site} ${why}. Sign in yourself with \`tooldrop logins verify ${site} --by-hand\`, and toolDrop keeps that session.`,
    { details: { by_hand: true } },
  );
}
