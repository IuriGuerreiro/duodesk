# DuoDesk desktop

Electron reuses the React receiver and the existing Rust signaling crate. Tauri remains available. Android and iOS code and the shared protocol are unchanged.

## Run

Use Node 24+, pnpm 11.18.0, and stable Rust with Cargo. Rust edition 2024 requires Rust 1.85+. Install a native C/C++ toolchain for the signaling crate: build-essential on Linux, Xcode Command Line Tools on macOS, or Visual Studio Build Tools with Desktop development with C++ on Windows. Windows development should use native Windows rather than WSL.

```sh
pnpm install --frozen-lockfile
pnpm dev:desktop
```

This builds the local UI and native signaling binary, then starts Electron. Restart after edits. `pnpm --filter @duodesk/desktop ui:dev` runs the UI preview with Vite; it has no native receiver. `pnpm dev:desktop:tauri` starts the retained Tauri host with Vite and requires the existing Tauri OS dependencies, including WebKitGTK on Linux. Linux WebKitGTK without RTCPeerConnection cannot receive video; Electron supplies Chromium WebRTC.

Select a LAN IPv4 address, create an invitation, and scan it from the Android or iOS Stream test tab. Keep both devices on the same network. Invitations expire after two minutes and are consumed by the first authenticated connection. The current mobile test-video flow, receiver controls, QR data, and diagnostics are unchanged.

Linux needs a graphical X11 or Wayland session and Electron's GTK/NSS/audio/graphics runtime libraries. Ubuntu packages commonly include libgtk-3-0, libnss3, libasound2t64, libgbm1 and libxss1. AppImage may require FUSE 2, or use the deb package. Native Linux binaries inherit the build host's glibc requirements; build on the oldest supported distribution and test on your target distributions. Keep Chromium's sandbox enabled. Hosts that disable unprivileged user namespaces need an administrator-supported Chromium sandbox setup; do not ship `--no-sandbox` as a workaround.

## Build and check

```sh
pnpm build:desktop
pnpm --filter @duodesk/desktop test
pnpm --filter @duodesk/desktop test:host
pnpm --filter @duodesk/desktop test:electron
pnpm --filter @duodesk/desktop package:dir
pnpm --filter @duodesk/desktop package
cargo test --locked --manifest-path apps/desktop/src-tauri/signaling/Cargo.toml
```

To test the actual receiver with H.264, run `pnpm --filter @duodesk/desktop exec vite --host 127.0.0.1 --port 1422 --strictPort` in one terminal, then `pnpm --filter @duodesk/desktop test:receiver` in another. This uses the existing receiver fixture on a dedicated loopback port, separate from concurrent worktrees.

The desktop Turbo build disables caching because its sidecar is specific to the host OS and architecture. Cargo still reuses its own compiled dependencies.

`test:electron` requires a graphical session. It starts the real shell, checks the isolated preload and invitation IPC, then sends canvas video between two Chromium peers with no ICE servers and checks decoded frames. It does not simulate a physical mobile device or prove another machine can reach the host. Rust tests separately exercise TLS authentication, one-use pairing, forwarding, and cancellation.

Packages go to `apps/desktop/release`. Build on each target OS and architecture: Linux produces AppImage/deb, macOS dmg/zip, Windows NSIS. The Rust sidecar is compiled for the build machine, so passing a different Electron target/architecture alone is unsupported. Use a matching native runner, including separate Intel and Apple Silicon macOS runners when needed. The manual `Native Electron package check` GitHub workflow builds unsigned packages on all three OSes. It must run before claiming cross-platform packaging validation.

Unsigned macOS builds can trigger Gatekeeper; distribution needs Developer ID signing and notarization. Windows unsigned installers can trigger SmartScreen; trusted distribution needs code signing. Configure electron-builder signing credentials in your release environment. Sign the bundled Rust executable as well as the app. No credentials are required for local development. This repository does not publish automatically.

Allow the DuoDesk signaling executable through the OS firewall on private networks. Signaling binds one selected interface on a random TCP port; WebRTC uses negotiated UDP ports. On Windows, the sidecar may need its own firewall allowance. macOS can prompt for incoming connections and local-network access. Linux firewall policies may need explicit LAN allowances. Guest Wi-Fi isolation, VPNs, or blocked UDP can prevent video even when pairing succeeds. There are no public signaling, STUN, or TURN services.

## Host boundary and integration

`src/host/index.ts` is the only React host adapter. It keeps the existing four command names and stream-event payloads. Electron's sandboxed preload exposes only command invocation and event subscription. Main validates the sender, exact command shapes, and bounded signal fields. The renderer loads only bundled assets on `duodesk://app`, cannot navigate or open windows, has no Node integration, and cannot request camera/microphone permissions. Its CSP denies renderer network connections. WebRTC media sockets still operate separately from fetch/WebSocket CSP.

`electron/host.mjs` owns one child process and bounded pending requests. `src-tauri/signaling/src/bin/duodesk-host.rs` wraps the existing signaling library with private bounded JSON lines over stdin/stdout. The library still owns certificates, invitation tokens, expiry, network message validation, and sockets. Mobile retains certificate fingerprint pinning. No TLS-verification bypass is added. EOF, window close, reload, renderer crash, or app quit releases the sidecar and its ports. Host failure rejects pending commands and fails the active session. A new invitation is required after failure.

The concurrent Android capture work should not conflict: no mobile capture files changed. Pairing work may conflict in `src/App.tsx`, desktop scripts, and the signaling crate. Preserve its pairing UI and protocol changes, route host calls through `src/host/index.ts`, and extend both Electron validation and the Rust JSON-lines dispatcher for any new command. Update both host event types when adding pairing events. Keep pairing logic in the shared Rust library rather than duplicating it in Electron. The six-digit pairing protocol is intentionally not implemented in this branch.

Security references: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security/), [sandboxed preloads](https://www.electronjs.org/docs/latest/tutorial/sandbox), [custom protocols](https://www.electronjs.org/docs/latest/api/protocol), and [native packaging constraints](https://www.electron.build/docs/features/multi-platform-build/).

## Validation on this branch

Linux x64: AppImage and deb packaging, production build, lint, desktop type checks, receiver unit tests, Rust TLS/signaling tests, and native process/port cleanup passed. The real sandboxed Electron shell loaded the bundled UI and created/stopped an invitation through preload IPC. Chromium loopback decoded video, and the existing VideoReceiver fixture decoded H.264 at 640 × 360. These are synthetic senders on one Linux host. Physical Android/iOS streaming, Windows/macOS packages, firewall prompts, signing, and installation on clean machines remain unverified.

Workspace type checking currently fails in unchanged mobile CSS imports in `animated-icon.web.tsx` and `theme.ts`. The production dependency audit reports existing Expo/Metro dependency advisories. This port does not change those mobile dependencies.

## Receiver workspace UI

The desktop receiver uses local shadcn/ui Button, Badge, Alert, Separator, and Textarea components, generated with the shadcn CLI. Tailwind v4 runs through the Vite plugin; `components.json` and the `@/*` TypeScript/Vite aliases are scoped to this app. Add components with `pnpm dlx shadcn@latest add <component> -c apps/desktop`. Setup follows the [official existing Vite project guide](https://ui.shadcn.com/docs/installation/vite). Fonts use the OS UI stack and monospace for addresses and measurements, with no remote font requests.

`src/components/receiver-workspace.tsx` owns the responsive receiver layout and status/error/empty presentations. `App.tsx` retains host invocation, subscription, receiver ownership, video refs, metrics, and cleanup. Native video controls remain available; fullscreen enables during streaming. Diagnostics disclose codec, resolution, frame rate, bitrate, lost packets, dropped frames, and decode time. QR and read-only manual invitations remain available; clipboard failure leaves selectable text.

Integration with `feat/electron-six-digit-pairing` was coordinated with its active thread. Both branches use `ReceiverWorkspaceProps`: `desktopAvailable`, named `interfaces` with `address`, `kind`, and `selectable`, `videoRef`, `onRefresh`, and optional `pairing: { address, code, status }`. The code is supplied by the pairing feature, never generated by this UI. Empty or expired codes are hidden. When supplied, address/code is shown first and QR is expandable. Preserve the pairing branch's `App.tsx`, host, protocol, and explicit adapter-selection behavior when combining the branches; replace its plain workspace with this presentation. This branch maps the current host's string addresses into that contract and continues to use QR pairing. Resolve `package.json` and `pnpm-lock.yaml` by retaining both features' dependencies and running pnpm, rather than taking either lockfile wholesale. Shared overlap is limited to desktop `App.tsx`, the workspace component, CSS, desktop package metadata, and the workspace lockfile.

`pnpm --filter @duodesk/desktop test:ui` runs the actual renderer controls against Electron's native host. It requires a graphical session, like `test:electron`. Browser preview has no host and clearly explains that limitation. Visual state fixtures used during development are browser-memory-only and are not shipped in the app.

Redesign validation on Linux x64: desktop lint/type checks, production UI/native-host build, four receiver/IPC unit tests, two host integration tests, actual Electron UI create/stop checks, and sandboxed Electron loopback decoding passed. The H.264 receiver fixture decoded 11 frames at 640 × 360 using this worktree's Vite server on port 18464. It emitted one decoder warning before succeeding and reported three dropped frames. T3 browser preview was inspected at desktop and narrow widths, including browser-only, pairing/code, error, loading, and streaming presentation states; fixtures do not establish native connectivity. No Windows/macOS runtime, packaging, physical phone stream, or cross-machine network validation was performed for this redesign.
