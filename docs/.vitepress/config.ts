import { defineConfig } from 'vitepress';

const repo = 'https://github.com/nabeelali0707/toolDrop';

export default defineConfig({
  title: 'toolDrop',
  description: 'Turn website tasks into fast, self-healing tools for AI agents. Free, local and open source.',
  // Served from GitHub Pages at https://nabeelali0707.github.io/toolDrop/
  base: '/toolDrop/',
  cleanUrls: true,
  lastUpdated: true,
  // Self-hosting pages link to the local server, which no build can reach.
  ignoreDeadLinks: 'localhostLinks',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Recipes', link: `${repo}/tree/main/recipes` },
      { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
    ],
    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Getting started', link: '/getting-started' },
          { text: 'Concepts', link: '/concepts' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Building a tool', link: '/building-a-tool' },
          { text: 'Recording mode', link: '/recording-mode' },
          { text: 'Watches and webhooks', link: '/watches-and-webhooks' },
          { text: 'Safe mode', link: '/safe-mode' },
          { text: 'Auth and 2FA', link: '/auth-and-2fa' },
          { text: 'Multi-site workflows', link: '/workflows' },
          { text: 'Code export', link: '/code-export' },
        ],
      },
      {
        text: 'Running toolDrop',
        items: [
          { text: 'Models', link: '/models' },
          { text: 'The dashboard', link: '/dashboard' },
          { text: 'Self-hosting', link: '/self-hosting' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Security', link: '/security' },
          { text: 'FAQ', link: '/faq' },
          { text: 'Recorder privacy policy', link: '/privacy' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    search: { provider: 'local' },
    footer: { message: 'Released under the Apache-2.0 license.', copyright: 'toolDrop contributors' },
  },
});
