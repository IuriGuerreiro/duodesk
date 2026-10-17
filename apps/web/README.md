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

With Wrangler installed and authenticated to the configured Cloudflare account, run from the repository root:

```sh
pnpm --filter @duodesk/web build
wrangler deploy --config apps/web/wrangler.jsonc
```

The Wrangler configuration manages the custom domain and serves only the production `dist` directory.
