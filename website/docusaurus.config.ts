import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'pi — Local AI Coding Agent',
  tagline: 'A self-extensible, local-first AI coding agent that runs on your machine with your credentials.',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  url: 'https://bramburn.github.io',
  // Set the /<baseUrl>/ pathname under which your site is served
  baseUrl: '/pi/',

  // GitHub pages deployment config.
  organizationName: 'bramburn',
  projectName: 'pi',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  // SEO
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/bramburn/pi/edit/main/website/',
          showLastUpdateTime: true,
          showLastUpdateAuthor: false,
          breadcrumbs: true,
          // Use doc item labels for versioning
          lastVersion: 'current',
          versions: {
            current: {
              label: 'Latest',
              path: '',
              badge: true,
            },
          },
        },
        blog: false, // no blog
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/social-card.png',
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },

    // SEO / OG
    metadata: [
      {
        name: 'keywords',
        content: 'AI coding agent, local AI, Claude, GPT, coding assistant, CLI, pi, pi.dev',
      },
      {name: 'twitter:card', content: 'summary_large_image'},
      {name: 'og:type', content: 'website'},
      {name: 'og:site_name', content: 'pi — Local AI Coding Agent'},
    ],

    announcementBar: {
      id: 'v0842',
      content:
        'You are reading the <strong>bramburn/pi</strong> fork docs. For the upstream project visit <a href="https://pi.dev/docs/latest" target="_blank" rel="noopener noreferrer">pi.dev/docs/latest</a>.',
      backgroundColor: '#1a1f2e',
      textColor: '#e0e6f0',
      isCloseable: true,
    },

    navbar: {
      title: 'pi [bramburn fork]',
      logo: {
        alt: 'pi logo',
        src: 'img/logo.svg',
        srcDark: 'img/logo-dark.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docs',
          position: 'left',
          label: 'Docs',
        },
        {
          type: 'docSidebar',
          sidebarId: 'architecture',
          position: 'left',
          label: 'Architecture',
        },
        {
          type: 'docSidebar',
          sidebarId: 'fork',
          position: 'left',
          label: 'This Fork',
        },
        {
          href: 'https://github.com/bramburn/pi',
          position: 'right',
          className: 'header-github-link',
          'aria-label': 'GitHub repository',
        },
      ],
    },

    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Introduction', to: '/docs/intro'},
            {label: 'Getting Started', to: '/docs/getting-started/installation'},
            {label: 'Architecture', to: '/docs/architecture'},
          ],
        },
        {
          title: 'This Fork',
          items: [
            {label: 'Why a Fork?', to: '/docs/fork/why-fork'},
            {label: 'Fork Features', to: '/docs/fork/features'},
            {label: 'Sync Process', to: '/docs/fork/sync'},
          ],
        },
        {
          title: 'Community',
          items: [
            {label: 'GitHub', href: 'https://github.com/bramburn/pi'},
            {
              label: 'Upstream (earendil-works/pi)',
              href: 'https://github.com/earendil-works/pi',
            },
            {label: 'pi.dev', href: 'https://pi.dev'},
          ],
        },
      ],
      copyright: `Built with Docusaurus. pi is MIT-licensed. The bramburn/pi fork is MIT-licensed. Copyright ${new Date().getFullYear()} bramburn.`,
    },

    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'powershell', 'json', 'yaml', 'toml', 'diff'],
    },

    mermaid: true,

    // Docs plugin config
    docs: {
      sidebar: {
        hideable: true,
        autoCollapseCategories: false,
      },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
