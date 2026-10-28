import { loginRecipeSchema, ToolDropError, type LoginRecipe, type Step } from '@tooldrop/core';
import { guardSignIn, type StorageState } from '@tooldrop/runtime';
import { CaptureSession, type CaptureOptions } from '../capture/capture.ts';
import type { AxNode, PageSnapshot } from '../capture/page-helpers.ts';
import { siteUrl } from '../generate/draft.ts';

// A site's login recipe, built by signing in once the way a person would
// (SPEC, Authentication: "run the site's login recipe, or build one"): find
// the sign-in form, fill it, answer the code page if one follows, and confirm
// the signed-in page. Heuristics, no model; a site they do not fit can be
// signed in from a recording instead.

/** What the builder signs in with. The code is asked for only when the site wants one. */
export interface LoginValuesSource {
  username: string;
  password: string;
  otp(): Promise<string>;
}

const SIGN_IN = /^(sign ?in|log ?in|login|sign on)\b/i;
const CODE = /code|otp|one-?time|verification|2fa|two-?factor|passcode/i;

const isPassword = (node: AxNode) => node.secret === true;

export interface LoginBuildOptions extends CaptureOptions {
  /** Origins besides the site's own where the login may be typed: identity providers the person allowed. */
  approvedOrigins?: readonly string[];
}

export async function buildLoginRecipe(
  url: string,
  values: LoginValuesSource,
  options: LoginBuildOptions = {},
): Promise<{ recipe: LoginRecipe; state: StorageState }> {
  const site = new URL(url).origin;
  const session = await CaptureSession.start(url, options);
  try {
    let page = await session.snapshot();
    if (!page.nodes.some(isPassword)) {
      const link = page.nodes.find((n) => (n.role === 'link' || n.role === 'button') && SIGN_IN.test(n.name));
      if (link) {
        await session.click(link.ref);
        page = await session.snapshot();
      }
    }
    const password = page.nodes.find(isPassword);
    if (!password) throw noForm(url);
    const signInPage = page.url;
    const before = page.nodes.slice(0, page.nodes.indexOf(password));
    const username = before.reverse().find((n) => n.role === 'textbox' && !n.secret);
    const submit = nextButton(page, password);
    if (!username || !submit) throw noForm(url);
    // Typed only on the site or an allowed identity provider, and never past a captcha.
    await guardSignIn(session.page, site, options.approvedOrigins ?? []);

    // Which recorded actions carry which saved value.
    const fills = new Map<number, string>();
    await session.fill(username.ref, values.username);
    fills.set(session.actions.length - 1, '{{input.username}}');
    await session.fill(password.ref, values.password);
    fills.set(session.actions.length - 1, '{{input.password}}');
    await session.click(submit.ref);
    page = await session.snapshot();

    const code = page.nodes.find(
      (n) => (n.role === 'textbox' || n.role === 'spinbutton') && !n.secret && CODE.test(n.name),
    );
    if (code && !page.nodes.some(isPassword)) {
      const verify = nextButton(page, code);
      if (!verify) throw noForm(url);
      await guardSignIn(session.page, site, options.approvedOrigins ?? []);
      await session.fill(code.ref, await values.otp());
      fills.set(session.actions.length - 1, '{{input.otp}}');
      await session.click(verify.ref);
      page = await session.snapshot();
    }
    if (page.nodes.some(isPassword) || page.url === signInPage) {
      throw new ToolDropError(
        'session_expired',
        `signing in to ${site} did not work: the site still asks to sign in. Check the saved login.`,
      );
    }

    const steps = session.actions.map((action, index): Step => {
      if (action.kind === 'goto') return { op: 'goto', url: siteUrl(action.url, site, true) };
      if (action.kind === 'click') return { op: 'click', target: action.target };
      if (action.kind === 'select') return { op: 'select', target: action.target, value: action.value };
      return { op: 'fill', target: action.target, value: fills.get(index) ?? action.value ?? '' };
    });
    const recipe = loginRecipeSchema.parse({
      url: siteUrl(signInPage, site),
      steps,
      check: { kind: 'page', url: siteUrl(page.url, site, true) },
    });
    return { recipe, state: await session.storageState() };
  } finally {
    await session.abort();
  }
}

/** The first button after an element: a form's submit button. */
function nextButton(page: PageSnapshot, after: AxNode): AxNode | undefined {
  return page.nodes.slice(page.nodes.indexOf(after) + 1).find((n) => n.role === 'button');
}

function noForm(url: string): ToolDropError {
  return new ToolDropError(
    'invalid_input',
    `toolDrop found no sign-in form it understands at ${url}; record the sign-in with \`tooldrop record\``,
  );
}
