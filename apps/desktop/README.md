# DuoDesk desktop

Electron reuses the React receiver and the existing Rust signaling crate. Tauri remains available. Both hosts share the six-digit pairing flow described in [device pairing](../../docs/device-pairing.md).

## Run

Use Node 24+, pnpm 11.18.0, and stable Rust with Cargo. Rust edition 2024 requires Rust 1.85+. Install a native C/C++ toolchain for the signaling crate: build-essential on Linux, Xcode Command Line Tools on macOS, or Visual Studio Build Tools with Desktop development with C++ on Windows. Windows development should use native Windows rather than WSL.

```sh
pnpm install --frozen-lockfile
pnpm dev:desktop
```

This builds the local UI and native signaling binary, then starts Electron. Restart after edits. `pnpm --filter @duodesk/desktop ui:dev` runs the UI preview with Vite; it has no native receiver. `pnpm dev:desktop:tauri` starts the retained Tauri host with Vite and requires the existing Tauri OS dependencies, including WebKitGTK on Linux. Linux WebKitGTK without RTCPeerConnection cannot receive video; Electron supplies Chromium WebRTC.

Select the Wi-Fi/Ethernet LAN IPv4 address matching your phone network, create a pairing code, then enter the shown desktop address and six digits in the Android or iOS Stream test tab. QR scanning remains available. Keep both devices on the same network. Invitations expire after two minutes and are consumed by the first authenticated connection. Invitation JSON is available under diagnostics. Rebuild the mobile development client to include its native pairing transport.

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

For another isolated preview port, set `DUODESK_RECEIVER_TEST_URL=http://127.0.0.1:PORT/test/loopback.html` when running `test:receiver`.

To test the actual receiver with H.264, run `pnpm --filter @duodesk/desktop exec vite --host 127.0.0.1 --port 1422 --strictPort` in one terminal, then `pnpm --filter @duodesk/desktop test:receiver` in another. This uses the existing receiver fixture on a dedicated loopback port, separate from concurrent worktrees.

The desktop Turbo build disables caching because its sidecar is specific to the host OS and architecture. Cargo still reuses its own compiled dependencies.

`test:electron` requires a graphical session. It starts the real shell, checks the isolated preload and invitation IPC, then sends canvas video between two Chromium peers with no ICE servers and checks decoded frames. It does not simulate a physical mobile device or prove another machine can reach the host. Rust tests separately exercise TLS authentication, one-use pairing, forwarding, and cancellation.

Packages go to `apps/desktop/release`. Build on each target OS and architecture: Linux produces AppImage/deb, macOS dmg/zip, Windows NSIS. The Rust sidecar is compiled for the build machine, so passing a different Electron target/architecture alone is unsupported. Use a matching native runner, including separate Intel and Apple Silicon macOS runners when needed. The manual `Native Electron package check` GitHub workflow builds unsigned packages on all three OSes. It must run before claiming cross-platform packaging validation.

Unsigned macOS builds can trigger Gatekeeper; distribution needs Developer ID signing and notarization. Windows unsigned installers can trigger SmartScreen; trusted distribution needs code signing. Configure electron-builder signing credentials in your release environment. Sign the bundled Rust executable as well as the app. No credentials are required for local development. This repository does not publish automatically.

Allow the DuoDesk signaling executable through the OS firewall on private networks. Signaling binds one selected interface on a random TCP port; WebRTC uses negotiated UDP ports. On Windows, the sidecar may need its own firewall allowance. macOS can prompt for incoming connections and local-network access. Linux firewall policies may need explicit LAN allowances. Guest Wi-Fi isolation, VPNs, or blocked UDP can prevent video even when pairing succeeds. There are no public signaling, STUN, or TURN services.

## Host boundary and integration

`src/host/index.ts` is the only React host adapter. It keeps the existing four command names and stream-event payloads. Electron's sandboxed preload exposes only command invocation and event subscription. Main validates the sender, exact command shapes, and bounded signal fields. The renderer loads only bundled assets on `duodesk://app`, cannot navigate or open windows, has no Node integration, and cannot request camera/microphone permissions. Its CSP denies renderer network connections. WebRTC media sockets still operate separately from fetch/WebSocket CSP.

`electron/host.mjs` owns one child process and bounded pending requests. `src-tauri/signaling/src/bin/duodesk-host.rs` wraps the existing signaling library with private bounded JSON lines over stdin/stdout. The library still owns certificates, invitation tokens, expiry, network message validation, and sockets. Mobile retains certificate fingerprint pinning. No TLS-verification bypass is added. EOF, window close, reload, renderer crash, or app quit releases the sidecar and its ports. Host failure rejects pending commands and fails the active session. A new invitation is required after failure.

Pairing uses the shared Rust library for bounded LAN bootstrap sockets and the shared TypeScript SRP implementation for authentication and invitation encryption. Electron's renderer has no direct signaling network access. `stream_pair_reply` passes through the validated IPC and JSON-lines dispatcher. `App.tsx` owns protocol logic; `ReceiverWorkspace` owns presentation so the desktop redesign can replace the UI without replacing pairing state. Capture APIs remain unchanged.

Security references: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security/), [sandboxed preloads](https://www.electronjs.org/docs/latest/tutorial/sandbox), [custom protocols](https://www.electronjs.org/docs/latest/api/protocol), and [native packaging constraints](https://www.electron.build/docs/features/multi-platform-build/).

## Validation on this branch

Linux x64: AppImage and deb packaging, production build, lint, desktop type checks, receiver unit tests, Rust TLS/signaling tests, and native process/port cleanup passed. The real sandboxed Electron shell loaded the bundled UI and created/stopped an invitation through preload IPC. Chromium loopback decoded video, and the existing VideoReceiver fixture decoded H.264 at 640 × 360. These are synthetic senders on one Linux host. Physical Android/iOS streaming, Windows/macOS packages, firewall prompts, signing, and installation on clean machines remain unverified.

Workspace type checking currently fails in unchanged mobile CSS imports in `animated-icon.web.tsx` and `theme.ts`. The production dependency audit reports existing Expo/Metro dependency advisories. This port does not change those mobile dependencies.
