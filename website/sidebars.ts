import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'doc',
      id: 'intro',
      label: 'Introduction',
    },
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: [
        'getting-started/installation',
        'getting-started/configuration',
      ],
    },
  ],

  architecture: [
    {
      type: 'doc',
      id: 'architecture',
      label: 'Overview',
    },
    {
      type: 'doc',
      id: 'architecture/packages',
      label: 'Package Overview',
    },
    {
      type: 'doc',
      id: 'architecture/event-loop',
      label: 'Agent Event Loop',
    },
    {
      type: 'doc',
      id: 'architecture/background-tasks',
      label: 'Background Tasks',
    },
    {
      type: 'link',
      label: 'Upstream docs',
      href: 'https://pi.dev/docs/latest',
    },
  ],

  fork: [
    {
      type: 'doc',
      id: 'fork/why-fork',
      label: 'Why a Fork?',
    },
    {
      type: 'doc',
      id: 'fork/features',
      label: 'Fork Features',
    },
    {
      type: 'doc',
      id: 'fork/experimental-mode',
      label: 'Experimental Mode',
    },
    {
      type: 'doc',
      id: 'fork/background-subagent',
      label: 'Background Subagent',
    },
    {
      type: 'doc',
      id: 'fork/sync',
      label: 'Sync Process',
    },
  ],
};

export default sidebars;
