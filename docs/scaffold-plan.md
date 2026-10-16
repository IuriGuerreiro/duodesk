# Template scaffold plan

Status: approved by user and authorized for implementation.

## Goal

Create a working pnpm + Turborepo repository from official starters. Preserve the generated starter screens so the first result proves the tooling and app shells. Product features follow in a separate task.

## Implementation sequence

1. Inspect the existing repository and preserve docs/architecture.md and this plan. Generate starters in temporary directories before integrating them, so no generator overwrites existing files. Record generator versions and commands in the README.
2. Generate the root using the official create-turbo basic starter with pnpm. Remove its example Next.js apps and unused UI package. Keep and adapt its workspace, Turbo, and shared tooling configuration.
3. Generate apps/desktop using official create-tauri-app, selecting React, TypeScript, and pnpm. Retain its Vite setup, Rust host, starter screen, and native command example.
4. Generate apps/mobile using official create-expo-app default TypeScript starter, retaining Expo Router and its example screens. Add expo-dev-client using Expo's dependency installer. Preserve the SDK's supported React and React Native versions rather than forcing every app to use identical versions.
5. Integrate both apps into one pnpm workspace and one lockfile. Adapt shared TypeScript and ESLint configurations without replacing framework-required settings. Use the current Expo monorepo defaults; add resolver or linker overrides only when the selected SDK requires them.
6. Add a minimal packages/protocol workspace with a version constant imported by both apps to verify shared package resolution. Do not invent the streaming protocol yet.
7. Configure Turbo tasks for lint, typecheck, build, and persistent uncached development servers. Provide explicit commands for desktop UI, native Tauri development, and mobile development. Native compilation and EAS cloud builds remain explicit commands, separate from the ordinary frontend build.
8. Add an EAS development profile and setup instructions for registering a physical iPad, signing, building in the cloud, installing, and connecting to Metro. Do not create an EAS project, purchase memberships, insert fake project IDs, or submit a cloud build in this scaffold task.
9. Add basic CI for frozen pnpm install, lint, typecheck, and available frontend/export checks. Document which native builds require Windows, macOS, signing, or additional host dependencies.
10. Verify the generated apps and report the commands that passed, failed, or could not run on this host. Update the README with prerequisites and exact development commands.

## Result

```text
apps/
  desktop/                 # Official Tauri React/TypeScript/Vite starter
  mobile/                  # Official Expo TypeScript/Router starter
packages/
  protocol/                # Minimal shared-package resolution check
  typescript-config/
  eslint-config/
docs/
  architecture.md
  scaffold-plan.md
```

## Acceptance criteria

- A fresh checkout installs with the pinned pnpm version and a frozen lockfile.
- Desktop starter builds with Vite; native Tauri compilation is checked where host prerequisites permit.
- Mobile starter passes Expo Doctor and a production bundle/export check for the supported target where possible. A web export alone is not evidence of a working iPad build.
- Both apps resolve the shared protocol package.
- Lint and typecheck pass through root Turbo commands.
- Starter screens remain recognizable and runnable; no screen sharing, pairing, remote control, redesign, website, or broadcast extension is implemented yet.
- README distinguishes local checks from unverified Windows and physical-iPad behavior.

## Implementation handoff

After approval, create a separate top-level T3 thread in this project using provider antigravity and model gemini-3.8-flash-medium, listed as Gemini 3.8 Flash (Medium). Give it the approved plan, existing architecture context, project path, and scope above. Recheck model availability at launch. Do not substitute another model silently.

## Official starter references

- https://turborepo.dev/docs/getting-started/installation
- https://v2.tauri.app/start/create-project/
- https://docs.expo.dev/more/create-expo/
- https://docs.expo.dev/guides/monorepos/
