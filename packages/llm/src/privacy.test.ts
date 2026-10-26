import { describe, expect, it } from 'vitest';
import { checkBudget, estimateTokens, fitPrompt } from './budget.ts';
import { isCloudModel, isExternal, isLocalEndpoint } from './endpoint.ts';
import { Masker, maskPatterns, MASKED, redactPii } from './redact.ts';

describe('isLocalEndpoint', () => {
  it.each([
    'http://127.0.0.1:11434',
    'http://127.8.9.1:8080/v1',
    'http://localhost:11434',
    'http://[::1]:11434',
    'http://ollama:11434',
    'http://host.docker.internal:11434',
  ])('counts %s as local', (url) => {
    expect(isLocalEndpoint(url)).toBe(true);
  });

  it.each([
    'https://api.example.test/v1',
    'http://192.168.1.20:11434',
    'http://ollama.example.test:11434',
    'http://127.0.0.1.example.test',
    'not a url',
  ])('counts %s as external', (url) => {
    expect(isLocalEndpoint(url)).toBe(false);
  });

  it('counts Ollama cloud models as external, even through a local Ollama', () => {
    expect(isCloudModel('qwen3.5:cloud')).toBe(true);
    expect(isCloudModel('gpt-oss:120b-cloud')).toBe(true);
    expect(isCloudModel('qwen2.5-coder:7b')).toBe(false);
    expect(isCloudModel('cloud')).toBe(false);
    expect(isExternal('http://127.0.0.1:11434', 'gpt-oss:120b-cloud')).toBe(true);
    expect(isExternal('http://127.0.0.1:11434', 'llama3.1:8b')).toBe(false);
  });
});

describe('Masker', () => {
  it('replaces registered secrets wherever they appear, also URL-encoded', () => {
    const masker = new Masker()
      .add('s3cr3t/pass+word', '[password]')
      .add('csrf-1234', '{{session.csrf}}')
      .add('ab', '[too short]');
    const text = 'login s3cr3t/pass+word, encoded s3cr3t%2Fpass%2Bword, header csrf-1234, ab stays';
    expect(masker.apply(text)).toBe(
      'login [password], encoded [password], header {{session.csrf}}, ab stays',
    );
  });

  it('replaces the longest secret first', () => {
    const masker = new Masker().add('token', '[a]').add('token-with-suffix', '[b]');
    expect(masker.apply('token-with-suffix token')).toBe('[b] [a]');
  });

  it('masks values by their shape or by the name they sit under', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(maskPatterns(`token ${jwt} end`)).toBe(`token ${MASKED} end`);
    expect(maskPatterns('Authorization: Bearer abcdefgh12345678')).toBe(`Authorization: Bearer ${MASKED}`);
    expect(maskPatterns('{"csrfToken": "q8w7e6", "status": "paid", "apiKey":"k-123"}')).toBe(
      `{"csrfToken": "${MASKED}", "status": "paid", "apiKey":"${MASKED}"}`,
    );
    expect(maskPatterns('user=alice&password=hunter22&page=2')).toBe(`user=alice&password=${MASKED}&page=2`);
  });

  it('keeps template placeholders, so the model sees where a secret goes', () => {
    expect(maskPatterns('{"x-csrf-token": "{{session.csrf}}"}')).toBe('{"x-csrf-token": "{{session.csrf}}"}');
    expect(maskPatterns('{"token": ""}')).toBe('{"token": ""}');
  });
});

describe('redactPii', () => {
  it('replaces emails, phone numbers and long numeric IDs', () => {
    expect(redactPii('mail ana.lopez+shop@example.co.uk now')).toBe('mail [email] now');
    expect(redactPii('call +1 (415) 555-0134 or 415-555-0134')).toBe('call [phone] or [phone]');
    expect(redactPii('account 123456789012 and card 4111 1111 1111 1111')).toBe(
      'account [number] and card [number]',
    );
    expect(redactPii('office 020 7946 0958')).toBe('office [phone]');
  });

  it('keeps dates, prices and short numbers', () => {
    const text = 'on 2026-01-03 total 844.64 for INV-1001, 12 items';
    expect(redactPii(text)).toBe(text);
  });
});

describe('budgets', () => {
  it('estimates 3 characters per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(2);
  });

  it('fails a prompt over budget with a clear error', () => {
    expect(() => checkBudget('write_recipe', 'x'.repeat(31), 10)).toThrow(
      expect.objectContaining({ code: 'llm_prompt_too_large' }),
    );
    expect(() => checkBudget('write_recipe', 'x'.repeat(30), 10)).not.toThrow();
  });

  it('prunes level by level until the prompt fits', () => {
    const levels = ['x'.repeat(90), 'x'.repeat(60), 'x'.repeat(30)];
    expect(fitPrompt('summary', (level) => levels[level], 10)).toBe('x'.repeat(30));
    expect(() => fitPrompt('summary', (level) => levels[level], 5)).toThrow(/budget of 5/);
  });
});
