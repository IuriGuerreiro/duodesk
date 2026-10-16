# DuoDesk mobile

The official Expo SDK 58 TypeScript/Router starter screens are preserved. This app is part of the pnpm workspace. Install from the repository root, using Node 24.14.0 and pnpm 11.18.0:

```sh
pnpm install --frozen-lockfile
pnpm dev:mobile
pnpm --filter @duodesk/mobile lint
pnpm --filter @duodesk/mobile check-types
pnpm --filter @duodesk/mobile build
```

`build` exports iOS, Android, and web JavaScript/assets. It does not compile a native app. `dev:mobile` starts Metro for the installed development client.

See the [root README](../../README.md) for physical iPad registration, Apple signing, EAS build/install, Metro connection, native build prerequisites, and starter provenance. Add dependencies through `pnpm --filter @duodesk/mobile exec expo install <package>` from the root.

Routes live in `src/app/`. The optional `pnpm --filter @duodesk/mobile reset-project` command removes or moves starter code; do not run it when preserving the template.
