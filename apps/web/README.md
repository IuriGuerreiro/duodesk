# DuoDesk marketing site

A standalone Vite landing page in the DuoDesk workspace. Uses plain JavaScript and CSS, with no UI framework. The device illustration is a concept preview, not a working streaming client.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:web
pnpm --filter @duodesk/web build
pnpm --filter @duodesk/web preview
```

Development runs at http://localhost:5174. Production output is in `apps/web/dist`.

Fonts load from Google Fonts with local sans-serif fallbacks. No signup data is collected. Platform support and remote controls are described as planned, pending device validation.

## Cloudflare deployment

The site is deployed as static assets on Cloudflare Workers at https://doudesk.elorenlabs.com.

After installing workspace dependencies and authenticating Wrangler to the configured Cloudflare account, run from the repository root:

```sh
pnpm deploy:web
```

The Wrangler configuration manages the custom domain and serves only the production `dist` directory.

## Production releases

`main` is the development branch. Merge a pull request into `prod` to publish automatically. The Marketing site workflow builds the site, validates Wrangler configuration without deploying, and deploys the same build artifact only from `prod`. Other branches and pull requests never deploy.

`prod` requires a pull request, the `Web build and config` check on an up-to-date branch, and resolved review conversations. Force pushes and branch deletion are disabled, including for admins. No additional reviewer is required, so the repository owner can merge their own PR after checks pass.

The GitHub `production` environment allows deployments only from `prod`. Set its `CLOUDFLARE_API_TOKEN` secret using Cloudflare's Edit Cloudflare Workers token template, restricted to the configured account and the `elorenlabs.com` zone. Do not copy a local OAuth token into CI. Account and custom-domain configuration live in `wrangler.jsonc`.

Wrangler is pinned as a project dependency. Local commands from the repository root:

```sh
pnpm --filter @duodesk/web check:deploy
pnpm deploy:web
```

The second command is a manual production deployment and requires Cloudflare authentication. Normal releases go through `prod`. To retry a production deployment, run the Marketing site workflow manually with the `prod` branch selected.

Branch rules are recorded in `.github/prod-branch-protection.json`. A repository admin can reapply them with:

```sh
gh api --method PUT repos/IuriGuerreiro/duodesk/branches/prod/protection \
  --input .github/prod-branch-protection.json
```
