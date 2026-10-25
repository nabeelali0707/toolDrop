import { defineConfig } from 'vitest/config';

// `pnpm test` runs every unit and end-to-end test. Tests that call real Ollama
// models (*.llm.test.ts) only run with `pnpm test:llm`, never in CI.
const llmOnly = process.env.TOOLDROP_LLM_TESTS === '1';
const testFiles = '{apps,packages,fixtures,scripts}/**/*.test.ts';
const llmTestFiles = '{apps,packages,fixtures,scripts}/**/*.llm.test.ts';

export default defineConfig({
  test: {
    include: [llmOnly ? llmTestFiles : testFiles],
    exclude: ['**/node_modules/**', ...(llmOnly ? [] : [llmTestFiles])],
    passWithNoTests: llmOnly,
    testTimeout: llmOnly ? 300_000 : 15_000,
  },
});
