# Desktop-to-phone screen sharing

The desktop shares its screen and an Android phone watches it. The phone-to-desktop test stream still works. Only the media direction differs.

Background and measurements are in the [capture spike](linux-to-mobile-spike.md).

## How it works

- The desktop picks a direction when it creates a connection: `phone-to-desktop` (Receive from phone) or `desktop-to-phone` (Share this screen). The direction is a field of the invitation, so pairing delivers it to the phone inside the encrypted invitation.
- After pairing, the offerer is the device that shares its screen. The route table says who may send what:

  | Direction          | Desktop sends                 | Phone sends                   |
  | ------------------ | ----------------------------- | ----------------------------- |
  | `phone-to-desktop` | `answer`, `candidate`, `stop` | `offer`, `candidate`, `stop`, `pause` |
  | `desktop-to-phone` | `offer`, `candidate`, `stop`  | `answer`, `candidate`, `stop` |

  `pair` and `paired` are direction-independent handshake messages and are not in the table. A repeat of either after pairing is rejected.

- There is one table per codebase: `packages/protocol/src/stream/direction.ts`, `signaling/src/lib.rs`, `electron/host.mjs` (desktop's side only, checked against the protocol table by a test), and `StreamProtocol.kt`. The iOS parser accepts only `phone-to-desktop`.
- The desktop captures with Chromium `getDisplayMedia`, so there is no native Linux capture code. The same code should work on Windows and macOS, but that is not tested.
- Capture starts automatically when the phone pairs with a desktop-to-phone session. Nothing is captured while waiting for the phone. A failed capture shows **Retry sharing**.
- The desktop offers H.264 first and VP8 second. The Android phone answers with what its decoders support. A phone without a hardware H.264 decoder should land on VP8.
- Electron keeps every permission denied except one narrow grant. While a `desktop-to-phone` session is open, our own window may capture video only (no audio, no camera, no microphone). The rules are in `apps/desktop/electron/capture.mjs`.
- On Android, `StreamViewer` answers the offer and renders into `StreamViewerView` (a `SurfaceViewRenderer`) in the existing native module. The viewer and sender share `PinnedSignaling`, process initialization, and an EGL context. The sender uses a separate `PeerConnectionFactory` for its playback-audio device module. Frames never go through JavaScript.
- Scanning a pairing QR on the phone's home screen routes by the invitation's direction: sender for `phone-to-desktop`, the viewer at `/watch` for `desktop-to-phone`.

## What was verified

On 2026-10-24, the user confirmed Linux-to-phone sharing working on a connected Samsung SM_A266B after installing the current Android debug build.

On this Linux x64 machine (X11, Electron 44.8):

- Protocol, desktop and Rust tests, lint and type checks pass.
- `pnpm --filter @duodesk/desktop test:sender` runs the real app, the real Rust host and real screen capture. Node stands in for the phone: SRP pairing, pinned TLS and signaling. A hidden Chromium window stands in for the phone's decoder. It decoded the shared screen as H.264 at 1920x1080 and about 30 fps.
- Kotlin compiles, the module's JVM unit tests pass, and `./gradlew :app:assembleDebug` builds an arm64 debug APK with the viewer.

Not verified:

- Anything on a real phone: pairing from the app, decode, rendering, frame rate, latency, battery. The test above does not exercise the Android viewer code.
- Which codec a real phone picks.
- Wayland and PipeWire capture. This machine has no Wayland session.
- Windows and macOS capture and packaging.
- iOS. The Swift parser change is unbuilt, and there is no iOS viewer.
- Whether the Tauri host works. It compiles (`cargo check`) but was not run, and Linux WebKitGTK has no `getDisplayMedia`. Screen sharing is an Electron feature.

## Test on an Android phone

You need a development build of the mobile app and the Linux desktop on the same Wi-Fi.

1. Build and install the app. From `apps/mobile`: `npx expo run:android --device`, with the phone on USB debugging. This includes the new native viewer. Start Metro if the build asks for it: `pnpm dev:mobile`.
2. On the desktop run `pnpm dev:desktop`. Use an X11 session.
3. Choose **Share this screen**. Pick the Wi-Fi or Ethernet address on your phone's network, not a Tailscale or Docker one. Choose **Create connection**.
4. On the phone open DuoDesk, tap **Scan QR code**, and scan the QR on the desktop pairing screen. Or enter the address and six-digit code. Allow local network access if asked.
5. The phone should open a screen titled "Connected." The desktop should start sharing automatically.
6. The phone should show the desktop screen, with codec, size and fps beneath it. The desktop toolbar shows the same from the sender side.
7. Stop from either side. The other side should end within a few seconds.

Please report: the codec shown on the phone, fps, whether the picture is black or garbled, and how it feels when you move a window. If pairing times out, check the desktop firewall, VPNs and guest Wi-Fi isolation. If the phone says "Video connection lost", try again and note the desktop's message.

The viewer is portrait only for now. The picture is small on a phone held upright.

## Collect screen-sharing diagnostics

Run the current checkout with `pnpm dev:desktop`. Reproduce the failure once, then close DuoDesk. Startup prints the exact `logPath` for `screen-share.jsonl` in the terminal. Send that file, plus `screen-share.jsonl.previous` if present. The file rotates at 5 MB and keeps one previous file.

On Linux, find the file with:

```sh
find "${XDG_CONFIG_HOME:-$HOME/.config}" -path '*/logs/screen-share.jsonl*' -print
```

The log records the desktop session and GPU capabilities, capture permission decision, screen source count, actual capture exception, captured dimensions, track mute events, signaling message types, ICE and peer states, encoder frame counts, and transport byte counts. It does not record the pairing code, invitation, SDP, raw ICE candidates, or screen pixels. Capture errors also retain their original name and message in the UI.

Interpret the last successful stage:

- `capture-request` denied: the app rejected the capture request before Linux capture.
- `capture-error` or zero sources: investigate the desktop capture backend and Linux session.
- `capture-track` then ICE stuck checking or failed: investigate connectivity between the phone and desktop.
- Connected with no encoded frames: investigate capture or encoder state, including track mute events.
- Encoded frames and increasing transport bytes: collect phone-side decoder and rendering logs next.

A desktop sender smoke test uses a Chromium receiver, not the Android viewer. Passing it cannot establish that a real phone decodes or renders the stream.
