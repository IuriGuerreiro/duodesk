# DuoDesk marketing site

A standalone Vite landing page in the DuoDesk workspace. Uses plain JavaScript and CSS. The device illustration is a concept preview, not a working streaming client.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:web
pnpm --filter @duodesk/web build
pnpm --filter @duodesk/web preview
```

Development starts on port 5174, or the next available port. Production output is in `apps/web/dist`. Fonts load from Google Fonts with local sans-serif fallbacks. No signup data is collected. Platform support and remote controls are planned, pending device validation.

## Cloudflare Workers Builds setup

The existing Worker is `duodesk-web`, serving https://doudesk.elorenlabs.com. Wrangler is pinned in this project's dependencies. `wrangler.jsonc` configures the Worker name, account, static assets, and custom domain.

Connect the repository manually in Cloudflare: Workers & Pages → duodesk-web → Settings → Builds → Connect repository.

Use these settings:

- Repository: `IuriGuerreiro/duodesk`
- Production branch: `prod`
- Root directory: repository root, `/`
- Build command: `pnpm --filter @duodesk/web... install --frozen-lockfile && pnpm --filter @duodesk/web build`
- Deploy command: `pnpm --filter @duodesk/web exec wrangler deploy`
- Non-production branch builds: disabled
- Build environment variable `NODE_VERSION`: `24.14.0`
- Build environment variable `PNPM_VERSION`: `11.18.0`
- Build environment variable `SKIP_DEPENDENCY_INSTALL`: `true`

The build command installs only the web workspace and its dependencies. Skipping automatic dependency installation prevents Cloudflare from installing the entire mobile/desktop workspace first. The deploy command uses the pinned Wrangler and finds `apps/web/wrangler.jsonc` from the web workspace directory. Select or create the deployment API token in Cloudflare's Builds settings. No GitHub Actions secret or deployment workflow is needed.

After connecting, merges into `prod` trigger Cloudflare's own build and deployment. The repository does not deploy this site through GitHub Actions. Existing app validation workflows are separate from website deployment.

References: [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) and [build image and environment variables](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/).

## Branch protection

`main` is the development branch. `prod` requires a pull request and resolved review conversations. Force pushes and branch deletion are disabled, including for admins. No extra reviewer or GitHub status check is required, so the repository owner can merge their own PRs.

Rules are recorded in `.github/prod-branch-protection.json`. A repository admin can reapply them with:

```sh
gh api --method PUT repos/IuriGuerreiro/duodesk/branches/prod/protection \
  --input .github/prod-branch-protection.json
```

## Local deployment commands

```sh
pnpm --filter @duodesk/web check:deploy
pnpm deploy:web
```

The first command builds and validates Wrangler configuration without publishing. The second manually deploys production and requires local Cloudflare authentication.
