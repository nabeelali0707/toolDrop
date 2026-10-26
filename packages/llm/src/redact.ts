// What a prompt may not carry (SPEC, Privacy; DECISIONS.md, D-011).
//
// Masking is always on: credentials, cookies and tokens become placeholders
// in every prompt, local or external, so they can never end up in a recipe or
// a log. PII redaction (emails, phone numbers, long numeric IDs) is forced on
// for external endpoints and optional for local ones.

const MIN_SECRET_LENGTH = 4;
export const MASKED = '[masked]';

const SECRET_NAME =
  /(password|passwd|secret|token|api[_-]?key|apikey|session[_-]?id|sessid|csrf|xsrf|authenticity|otp|cookie|authorization)/i;
// A JSON member whose name says it holds a secret: "csrfToken": "abc".
const SECRET_MEMBER = /("([^"\\]*)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
// A form or query field: password=abc&...
const SECRET_FIELD =
  /\b([A-Za-z_]*?(?:password|passwd|secret|token|api_?key|csrf|xsrf|otp)[A-Za-z_]*=)([^&\s"']+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/**
 * Replaces secrets with placeholders. Known values are registered as they are
 * found (a cookie, a CSRF token, a password) and replaced wherever they
 * appear; patterns catch the rest. A placeholder such as `{{session.csrf}}`
 * keeps the model aware of where the value goes.
 */
export class Masker {
  readonly #values = new Map<string, string>();

  /** Registers a secret value and the placeholder that stands for it. */
  add(value: string | undefined, placeholder = MASKED): this {
    if (!value || value.length < MIN_SECRET_LENGTH) return this;
    this.#values.set(value, placeholder);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) this.#values.set(encoded, placeholder);
    return this;
  }

  get size(): number {
    return this.#values.size;
  }

  apply(text: string): string {
    // Longest first, so a secret that contains another is replaced whole.
    const known = [...this.#values].sort(([a], [b]) => b.length - a.length);
    let masked = text;
    for (const [value, placeholder] of known) masked = masked.replaceAll(value, placeholder);
    return maskPatterns(masked);
  }
}

/** Masks values that look secret by their shape or by the name they sit under. */
export function maskPatterns(text: string): string {
  return text
    .replace(JWT, MASKED)
    .replace(BEARER, (_match, scheme: string) => `${scheme} ${MASKED}`)
    .replace(SECRET_MEMBER, (match, prefix: string, name: string, value: string) =>
      SECRET_NAME.test(name) && value !== '' && !isPlaceholder(value) ? `${prefix}"${MASKED}"` : match,
    )
    .replace(SECRET_FIELD, (match, prefix: string, value: string) =>
      isPlaceholder(value) ? match : `${prefix}${MASKED}`,
    );
}

function isPlaceholder(value: string): boolean {
  return value === MASKED || /^\{\{[^{}]+\}\}$/.test(value);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// A run of digits, with the separators phone numbers use, holding 9 or more digits.
const LONG_NUMBER = /(?<![\w.])\+?\d(?:[\d ().-]*\d)?(?![\w])/g;
const MIN_ID_DIGITS = 9;

/** Replaces emails, phone numbers and long numeric IDs. */
export function redactPii(text: string): string {
  return text.replace(EMAIL, '[email]').replace(LONG_NUMBER, (match) => {
    const digits = match.replace(/\D/g, '').length;
    if (digits < MIN_ID_DIGITS) return match;
    return isPhone(match, digits) ? '[phone]' : '[number]';
  });
}

/** Either way the value is gone; the label only tells the model what stood there. */
function isPhone(match: string, digits: number): boolean {
  if (/^\+|\(/.test(match) || /\d-\d{3,4}-\d{4}$/.test(match)) return true;
  // Spaced groups are phone numbers up to 12 digits; longer ones are card or account numbers.
  return match.includes(' ') && digits <= 12;
}
