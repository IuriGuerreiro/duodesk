# Test-video streaming

The first implementation sends a bundled silent MP4 from the foreground iPad app to the Windows receiver. Screen broadcasting is a later milestone.

## Implementation

- `packages/protocol/src/streaming.ts` validates invitations and signaling messages.
- `apps/desktop/src-tauri/signaling` owns the TLS listener, expiring one-use invitations, authentication, and bounded signaling transport.
- `apps/desktop/src/streaming/receiver.ts` owns browser WebRTC negotiation, video delivery, diagnostics, and teardown.
- `apps/mobile/modules/test-video/ios` owns native signaling, certificate pinning, WebRTC, and AVFoundation decoding.
- `apps/mobile/src/app/stream-test.tsx` provides QR/manual pairing, bitrate selection, and start/stop controls.

The iOS module uses Expo Modules directly and pins JitsiWebRTC 155.0.0. This replaces the proposed React Native WebRTC wrapper evaluation: a custom source can feed the same native peer connection without private wrapper integration or a second WebRTC framework. The app needs a new native development build. Expo Go cannot run this feature.

Video buffers remain native. The clip loops with monotonic capture timestamps, paced from presentation times, and a bounded decode loop. H.264 is required for this experiment, with RTX recovery where supported. Target output is 1080p/30 fps with a selectable 2–30 Mbps ceiling; actual encoding and quality depend on the device and network. Audio is not captured.

Invitations contain a certificate fingerprint and 256-bit secret. They expire after two minutes and are consumed on successful pairing. Reconnection requires a fresh invitation. The native iPad socket accepts only the exact pinned TLS certificate for the invited host. There is no global certificate bypass or public STUN/TURN dependency. Do not share invitation screenshots or paste their secrets into logs.

## Run on Windows

Install Node/pnpm and the Tauri Windows prerequisites described in the root README, then run:

```sh
pnpm install --frozen-lockfile
pnpm dev:desktop:tauri
```

Select the Windows Wi-Fi/Ethernet IPv4 address reachable by your iPad, then choose Create invitation. Allow the desktop executable through Windows Firewall on your private network. The listener uses an ephemeral TCP port, and WebRTC uses dynamically selected media ports, so an application firewall rule is preferable to opening one fixed port. Vite-only browser mode cannot start the native listener.

## Install on iPad

The user reports iPadOS 27 beta and existing Apple Developer/Expo accounts. Exact iPad hardware and OS build still need recording. This workspace is not logged into EAS.

From `apps/mobile`, choose a bundle identifier you control in `app.json`, then run:

```sh
npx eas-cli@latest login
npx eas-cli@latest build:configure
npx eas-cli@latest device:create
npx eas-cli@latest build --platform ios --profile development
```

Register the iPad before building, install from the resulting link, and enable Developer Mode when prompted. Start `pnpm dev:mobile` from the repository root and open the development client. EAS project linking, signing, and this cloud build have not been performed here.

On the same reachable LAN, open Stream test, scan the Windows invitation or paste its full JSON, then press Connect and Start video. Allow camera access for scanning and local network access for the connection. The camera is used only for QR scanning. Manual entry works without camera permission.

Keep DuoDesk in the foreground. The test screen prevents auto-lock during an active session. Backgrounding the app, leaving the test tab, stopping either side, or losing the connection ends the session. For another attempt, create a new Windows invitation. Guest Wi-Fi isolation, a VPN, or selecting a virtual adapter can prevent direct connections.

## Local checks completed

- Frozen pnpm install; root TypeScript checks and lint.
- Desktop Vite build and Expo production exports for iOS, Android, and web.
- Expo Doctor: 20/20 checks. iOS prebuild generation passed; native autolinking discovers `DuoDeskTestVideo` and `TestVideoModule`.
- Linux Tauri host `cargo check` and standalone signaling Rust tests/Clippy.
- Protocol and receiver tests cover invalid/stale messages, early ICE ordering, duplicate offers, and stopped-session teardown.
- Real TLS/WebSocket integration test covers incorrect authentication, one-use pairing, SDP forwarding, fingerprint consistency, and cancellation.
- Browser H.264 loopback decoded video through the production receiver module at 640×360. This verifies browser media delivery, not native iPad encoding or WebView2 performance.

## Device checks still required

Native Swift compilation, EAS installation, Windows WebView2 playback, and iPad-to-Windows transmission are unverified. No 1080p/30 quality, hardware acceleration, latency, thermal, or 15-minute stability result is claimed. A successful Expo export does not compile Swift.

After pushing the branch, the manual Native iOS compile check workflow can compile a simulator app on GitHub's macOS runner without signing. Windows native compilation and Rust signaling tests are also configured in CI. These workflows have not been run remotely for this change.

On actual Windows and iPad hardware, record model/OS/GPU, first-frame time, negotiated codec/resolution/fps/bitrate, dropped frames, and memory/thermal behavior over 15 minutes. Repeat start/stop/reconnect, reject expired/invalid invitations, and repeat with internet access disconnected but LAN Wi-Fi retained. Measure video latency separately; network round-trip time is not capture-to-display latency.

## Repeatable developer checks

Run `pnpm --filter @duodesk/protocol test`, `pnpm --filter @duodesk/desktop test`, and `cargo test --locked --manifest-path apps/desktop/src-tauri/signaling/Cargo.toml`.

For a browser-only media smoke test, start `pnpm dev:desktop`, open `/test/loopback.html` on its local URL, and press Run H.264 check. It exchanges generated canvas frames between local peer connections. It does not test the native TLS socket or iPad source.

The bundled five-second test pattern was generated specifically for this project with FFmpeg's `testsrc2`, not downloaded footage. To regenerate with an installed FFmpeg executable:

```sh
ffmpeg -y -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=5 -an -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -movflags +faststart apps/mobile/modules/test-video/ios/Resources/test-pattern.mp4
```
