# npm Trusted Publishing setup (bramburn/pi fork)

Replaces token-based `npm publish` with OIDC trusted publishing so the
fork's CI workflow can publish the `@bramburn/*` packages on tag push
without needing an OTP interactive prompt.

Source: <https://docs.npmjs.com/trusted-publishers>

## Current state

- GitHub Actions workflow `.github/workflows/publish.yml` already has
  `permissions: id-token: write` + `registry-url: https://registry.npmjs.org`
  set up correctly (needed for OIDC).
- The workflow still passes `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`
  to each `npm publish` step. With trusted publishing configured, npm
  prefers the OIDC token over the auth token and the secret becomes
  optional. Leave it in for now (no harm) and revoke it later once OIDC
  is verified.
- None of the `@bramburn/*` packages exist on npm yet
  (`https://registry.npmjs.org/@bramburn/<x>` returns 404 for every package).
  **Brand-new packages can only be published via `npm publish`, not via
  `npm stage publish`.** Set trusted publisher config to allow `npm publish`
  for the first release of each package. After that, you can switch the
  config to stage-only if you want a manual 2FA review on subsequent
  releases.

## Per-package setup on npmjs.com

Repeat these steps for each of the 8 packages. **Do this before pushing
the publish tag.**

| Scope | Publish workflow needs |
|-------|-------------------------|
| `@bramburn/pi-ai` | `bramburn/pi`, workflow `publish.yml` |
| `@bramburn/pi-tui` | same |
| `@bramburn/pi-telemetry` | same |
| `@bramburn/pi-protocol` | same |
| `@bramburn/pi-agent-core` | same |
| `@bramburn/pi-session-backend-sqlite-node` | same |
| `@bramburn/pi-coding-agent` | same |
| `@bramburn/pi-server` | same |

For each package:

1. Open `https://www.npmjs.com/package/@bramburn/<x>/edit` (you need to
   be logged in as `bramburn` and have publish access to the scope).
2. In the page sidebar, scroll to **Publishing access** and click
   **Add a trusted publisher** (or **Edit trusted publishers** if the
   row already exists).
3. Click **GitHub Actions**.
4. Fill in the form:
   - **Organization or user:** `bramburn`
   - **Repository:** `pi`
   - **Workflow filename:** `publish.yml`
   - **Environment name:** `npm-publish` (matches the GitHub environment
     declared in `.github/workflows/publish.yml`'s
     `jobs.publish.environment`)
   - **Allowed actions:** check **Allow npm publish**. (Optionally also
     check *Allow npm stage publish* if you plan to switch to staged
     publishing for future releases.)
5. Click **Add** (or **Update**) to save.

After saving, the package's settings should list one entry:
"bramburn / pi / publish.yml / npm-publish / Allow npm publish".

If you have access to all 8 packages under one scope, the UI is the same
for each; the bottleneck is doing this eight times manually. npm has no
batch endpoint for trusted publishers.

## Verify the workflow can publish

Once at least one trusted publisher is configured:

```bash
# Push the existing v0.84.2-b1 tag (it's already on the fork remote)
git push fork v0.84.2-b1 --force
```

The publish workflow should:

1. Install deps at repo root (`npm ci --ignore-scripts`).
2. `npm run build` builds every package (tsgo finds the linux-x64 binary
   from the optional dep).
3. Each per-package step runs `cd packages/<x> && npm publish --access public`.
   npm uses the OIDC token from GitHub Actions instead of `secrets.NPM_TOKEN`,
   so no OTP prompt and no 2FA issue.
4. Watch the run: `gh run watch --repo bramburn/pi --workflow "Publish npm packages"`.

Repeat the `git push v0.84.2-b1 --force` after re-pointing the tag at a new
commit if the workflow fails partway and you need to retry — the publish
helper is idempotent and skips versions already present on the registry.

## After the first publish lands

Once the `@bramburn/*` packages exist on npm:

- **Optional maximum-security step:** on each package's npmjs.com page,
  go to **Publishing access** and choose
  **"Require two-factor authentication and disallow tokens"**. This
  blocks traditional `secrets.NPM_TOKEN` publishing from working, so
  the only path to publish becomes OIDC. Token publish is already
  broken in our fork (EOTP), so this is mostly belt-and-suspenders.
- **Optional staging:** if you want a 2FA review step between CI and
  the public registry, edit the trusted publisher config to allow
  `npm stage publish` instead of `npm publish`. CI will then need to be
  updated to call `npm stage publish` per package, and a maintainer
  approves each on https://npmjs.com → Staged Packages tab. Per the
  docs, staged publishing only works for *updates* to existing packages,
  not initial creation, so this only takes effect from the second
  release onward.
- **Revoke `secrets.NPM_TOKEN`** in the fork's GitHub Actions secrets
  page once OIDC is verified for all 8 packages. Pure housekeeping.

## Match-up checklist

- [ ] `@bramburn/pi-ai` trusted publisher added (bramburn / pi / publish.yml / npm-publish)
- [ ] `@bramburn/pi-tui` trusted publisher added
- [ ] `@bramburn/pi-telemetry` trusted publisher added
- [ ] `@bramburn/pi-protocol` trusted publisher added
- [ ] `@bramburn/pi-agent-core` trusted publisher added
- [ ] `@bramburn/pi-session-backend-sqlite-node` trusted publisher added
- [ ] `@bramburn/pi-coding-agent` trusted publisher added
- [ ] `@bramburn/pi-server` trusted publisher added
- [ ] `git push fork v0.84.2-b1 --force` and `gh run watch` shows all
      publish steps succeed
- [ ] (Optional) flip each package to "Require 2FA + disallow tokens"
- [ ] (Optional) revoke `NPM_TOKEN` GitHub secret

## Reference

- Trusted publishers docs: <https://docs.npmjs.com/trusted-publishers>
- Staged publishing docs: <https://docs.npmjs.com/staged-publishing>
- Fork publish workflow: `.github/workflows/publish.yml`
- v0.84.2-b1 tag: currently points at `c418b1b21` (last working commit
  before the 2FA OTP failure)
