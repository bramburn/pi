import type {ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';

import styles from './index.module.css';

function HomepageHeader() {
  const {siteConfig} = useDocusaurusContext();
  return (
    <header className={clsx('hero', styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className={clsx('hero__title', styles.heroTitle)}>
          {siteConfig.title}
        </Heading>
        <p className={clsx('hero__subtitle', styles.heroSubtitle)}>
          {siteConfig.tagline}
        </p>
        <div className={styles.buttons}>
          <Link
            className="button button--primary button--lg"
            to="/docs/intro">
            Get started
          </Link>
          <Link
            className="button button--secondary button--lg"
            to="/docs/fork/why-fork">
            Why this fork?
          </Link>
        </div>
      </div>
    </header>
  );
}

function Feature({
  title,
  description,
  link,
  linkLabel,
}: {
  title: string;
  description: string;
  link?: string;
  linkLabel?: string;
}) {
  return (
    <div className={clsx('col', styles.feature)}>
      <Heading as="h3" className={styles.featureTitle}>
        {title}
      </Heading>
      <p className={styles.featureDescription}>{description}</p>
      {link && (
        <p>
          <Link to={link} className={styles.featureLink}>
            {linkLabel ?? 'Read more'} &rarr;
          </Link>
        </p>
      )}
    </div>
  );
}

export default function Home(): ReactNode {
  const {siteConfig} = useDocusaurusContext();
  return (
    <Layout
      title="Local AI Coding Agent"
      description={siteConfig.tagline}>
      <HomepageHeader />
      <main>
        <section className={styles.features}>
          <div className="container">
            <div className="row">
              <Feature
                title="Local-first"
                description="Runs entirely on your machine. No cloud dependency. Your API keys, your machine, your data."
              />
              <Feature
                title="Multi-provider"
                description="Anthropic Claude, OpenAI GPT, Google Gemini, Groq, and more — switch with one command."
              />
              <Feature
                title="Tool-augmented"
                description="Reads your codebase, runs shell commands, edits files, and searches the web. Extend it with your own tools."
              />
            </div>
            <div className="row" style={{marginTop: '1.5rem'}}>
              <Feature
                title="Terminal-native"
                description="A full terminal UI with a scrollback buffer, syntax highlighting, and keybindings you already know."
              />
              <Feature
                title="Fork of pi.dev"
                description="This is the bramburn/pi fork. It diverges from upstream in build tooling, release process, and selected features."
                link="/docs/fork/why-fork"
                linkLabel="See what's different"
              />
              <Feature
                title="MIT licensed"
                description="Open source. Use it, modify it, ship with it. The full monorepo is MIT-licensed."
              />
            </div>
          </div>
        </section>

        {/* Quick install block */}
        <section className={styles.installSection}>
          <div className="container">
            <Heading as="h2" className={styles.installTitle}>
              Quick install
            </Heading>
            <pre className={styles.installCode}>
              <code>npm install -g @bramburn/pi-codes</code>
            </pre>
            <p className={styles.installNote}>
              Or download a prebuilt binary from the{' '}
              <Link to="https://github.com/bramburn/pi/releases">GitHub releases</Link>.
            </p>
          </div>
        </section>
      </main>
    </Layout>
  );
}
