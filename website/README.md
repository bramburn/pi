# Website

This website is built using [Docusaurus](https://docusaurus.io/), a modern static website generator.

> The fork's primary runtime is **Bun**; this website follows the same
> pattern. CI (`.github/workflows/docs.yml`) uses `bun install --frozen-lockfile`
> and `bun run build`. Node.js (`npm install` / `npm run build`) still
> works for local development.

## Installation

```bash
bun install --frozen-lockfile
# or, equivalently:
npm install
```

**Note**: feel free to use the package manager of your choice.

## Local Development

```bash
bun run start
# or:
npm run start
```

This command starts a local development server and opens up a browser window. Most changes are reflected live without having to restart the server.

## Build

```bash
bun run build
# or:
npm run build
```

This command generates static content into the `build` directory and can be served using any static contents hosting service.

## Deployment

Using SSH:

```bash
USE_SSH=true bun run deploy
# or:
USE_SSH=true npm run deploy
```

Not using SSH:

```bash
GIT_USER=<Your GitHub username> bun run deploy
# or:
GIT_USER=<Your GitHub username> npm run deploy
```

If you are using GitHub Pages for hosting, this command is a convenient way to build the website and push to the `gh-pages` branch.
