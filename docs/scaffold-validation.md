# Scaffold validation

Validated on Linux, 2026-10-16, with Node 24.14.0 and pnpm 11.18.0. Baseline commit: `c91a100`.

## Review findings resolved

1. Desktop and protocol now use TypeScript ESLint recommended rules with a compatible parser. The warning-only plugin is removed.
2. Mobile has a committed SDK-matched Expo ESLint config and dependencies. Direct ESLint execution cannot bootstrap or install dependencies.
3. Mobile has `build` and `dev` aliases. Root Turbo includes Expo production exports and persistent, uncached Metro development.
4. GitHub Actions runs frozen installation, lint, typecheck, both app builds, and checks iOS/Android bundle metadata plus the web entry.
5. Root and mobile READMEs document pinned tooling, workspace commands, verifiable generator provenance, physical iPad/EAS setup, and native validation limits.
6. Both apps consume shared TypeScript settings while retaining Expo/Vite module resolution and JSX options.

## Checks passed

- `pnpm install --frozen-lockfile`.
- `pnpm lint` and `pnpm check-types` across desktop, mobile, and protocol.
- Lint stdin probes using actual desktop/mobile/protocol source paths rejected a deliberate `debugger` statement, including TS/TSX syntax.
- Mobile lint left SHA-256 hashes of its manifest and the lockfile unchanged.
- `tsc --showConfig` confirmed shared `noUncheckedIndexedAccess` and strict checking in both apps, with their framework module settings retained.
- `pnpm build`: desktop Vite production build and Expo iOS/Android/web production export.
- Exact CI export artifact checks passed locally; workflow YAML parsed. The hosted GitHub Actions run has not been executed.
- Expo Doctor: 20/20 checks; `expo install --check`: dependencies up to date.
- `pnpm dev --ui=stream` started Vite on port 1420 and Metro on port 8081. Stopped intentionally after readiness, using a bounded timeout.
- Source screens, `LICENSE.md`, and `NOTICE` unchanged from baseline.

## Review and limits

Reviewed correctness, readability, architecture, security, and performance. No remaining blocking findings. Lockfile changes add Expo/TypeScript lint tooling and remove the unused Babel 8 parser stack. TypeScript 6.0.3 matches the parser's supported range. One file-specific rule exception preserves the official Expo web hydration guard.

No Windows native compilation, physical iPad installation, signing, or device behavior was verified. Production JS/Hermes exports do not establish native correctness. The earlier Linux offline Cargo check remained incomplete. No EAS project, membership, cloud build, push, or PR was created.
