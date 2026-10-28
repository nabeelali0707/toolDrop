import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Draws the extension's icons, a drop with a recording dot, at the sizes
// Chrome asks for. Run it after a design change with
// `pnpm --filter @tooldrop/extension icons`; the PNGs are committed.

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#0c4a6e"/>
  <path d="M64 18C64 18 30 58 30 80a34 34 0 0 0 68 0C98 58 64 18 64 18z" fill="#38bdf8"/>
  <circle cx="64" cy="80" r="13" fill="#ef4444"/>
</svg>`;

const out = fileURLToPath(new URL('../public/icons/', import.meta.url));
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${ICON}`,
    );
    writeFileSync(`${out}${size}.png`, await page.screenshot({ omitBackground: true }));
  }
} finally {
  await browser.close();
}
