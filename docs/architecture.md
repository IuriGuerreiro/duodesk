# DuoDesk architecture proposal

Status: initial proposal, 2026-10-16. App starter shells now exist; product capabilities below remain proposed.

## Product scope

Share screens and optionally control the sending device over a local network. Each device advertises its capabilities; sharing and control are separate permissions. Start with one sender and one viewer per session, in either direction. Simultaneous bidirectional streams come later.

Assumptions: Tauri was intended by "Tari"; phones include Android and iPhone; initial desktop support is Windows. No account, internet connection, hosted relay, or subscription is required for the first release.

## Platform capabilities

| Device        | Send screen                     | View screen    | Allow remote control                                                                                               |
| ------------- | ------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| Windows       | Yes, native capture             | Yes            | Yes, subject to Windows privilege restrictions                                                                     |
| iPad / iPhone | User-initiated native broadcast | Yes            | Excluded from baseline; arbitrary system input injection has no established public implementation for this project |
| Android       | Yes, with session consent       | Yes            | Conditional, prototype a user-enabled accessibility implementation                                                 |
| Browser       | Optional later                  | Optional later | Can send commands to a paired native host; cannot provide general OS input injection itself                        |

An iPad can control Windows even though Windows cannot generally control the iPad. Do not represent these as a single symmetric feature. Protected content, lock screens, background execution, and audio need separate platform validation.

## Stack recommendation

- Desktop: Tauri 2 + React + TypeScript + Vite. Rust owns native integration, local signaling, device identity, and session lifecycle.
- Mobile: React Native + TypeScript, with native Swift and Kotlin modules. Plan for custom native builds and an iOS broadcast extension, rather than Expo Go.
- Media: WebRTC, starting with interoperable H.264 and hardware acceleration where available. Validate the actual codec profiles and device support before committing to a library.
- Website: defer it. If a landing/download page becomes useful, Vite can build it. A browser viewer is a separate feature with discovery, secure-origin, and certificate work.
- Repository: pnpm workspace for TypeScript, Cargo workspace when Rust modules exist. Share protocol schemas and session logic where useful; keep mobile and desktop rendering separate.

Tauri hosts web UI, so React DOM belongs inside it. React Native is the mobile UI choice, not something to embed in Tauri.

## Session flow

1. Windows advertises a local endpoint through mDNS. Mobile discovers it with native networking, with QR/manual address fallback.
2. QR pairing carries endpoint information and a high-entropy, expiring pairing secret. Authenticate the peer and pin its identity; do not trust the LAN or discovery announcements.
3. The host and viewer negotiate capabilities and permissions over an authenticated encrypted signaling connection. A short PIN, if added, needs a suitable authenticated pairing protocol and rate limits.
4. Exchange WebRTC offers and ICE candidates locally. Media travels directly between peers; no hosted signaling, SFU, public STUN, or TURN is required for the intended same-LAN baseline.
5. The sender grants screen capture through the operating system. Separately grant remote control on a supported host.
6. WebRTC carries video and optional audio. Its data channels carry input and session messages. The native host validates every input command against the current control grant.
7. Either device can stop the session. Disconnect or permission revocation releases held keys/buttons and stops input immediately.

Use lossy, latest-value delivery for pointer motion and reliable ordered delivery for key/button transitions. Include session identity, display identity, coordinate space, rotation, and sequence information. Translate normalized coordinates to the current captured display geometry. Handle stale events and stuck keys explicitly.

Local networks can still block peer traffic through guest isolation or firewalls. Show actionable connection errors. Manual addresses cannot bypass network isolation.

## Modules and seams

- Session module: pair, connect, request sharing/control, stop, observe state and errors. It owns negotiation, permission state, reconnect behavior, and teardown behind a small interface.
- Platform adapters: Windows capture/input, Apple broadcast capture, Android capture/input. Report actual capabilities and permission state rather than making UI infer them from platform names.
- Media module: capture-to-encoder-to-WebRTC and decoder-to-renderer. Keep frame buffers in native code. JavaScript receives state and statistics, not video frames through bridge messages.
- Protocol module: versioned schemas for discovery, pairing, capability negotiation, signaling, and control events. Shared schemas need validation and native bindings where native code consumes them.

Do not commit to one shared Rust media engine across mobile and desktop yet. First prove the WebRTC implementation, native capture integration, rendering path, and iOS extension lifecycle. Browser WebRTC in Tauri is a candidate, but native capture integration and copy overhead may justify a native media implementation.

## Proposed layout

```text
apps/
  desktop/             # React + Vite + Tauri
  mobile/              # React Native + iOS extension + Android modules
packages/
  protocol/            # Message schemas, versions, capability definitions
  session/             # Platform-independent session logic where practical
docs/
  architecture.md
  decisions/           # Decisions after feasibility experiments
```

Create native Rust crates only when the feasibility work establishes their responsibilities. Add apps/web only when there is a concrete website requirement.

## Feature map

Current code is split by feature. A feature exposes a public `index.ts`; everything else in its folder is private. Other code imports `@/features/<name>`, never a file inside it. ESLint enforces this (`no-restricted-imports` in `packages/eslint-config/rules.js`).

```text
apps/mobile/src/
  app/                       # thin routes; index loads the sender, stream-test redirects to it
  features/
    stream-sender/           # screen, use-sender-session, session copy
    pairing/                 # QR scanner, manual invitation entry, pairing client
  shared/                    # NativeWind tokens, UI primitives, utilities, shared types
  (native module: apps/mobile/modules/test-video, outside src)
apps/desktop/src/
  features/receiver/         # workspace UI, use-receiver-session, video-receiver (WebRTC)
  shared/                    # host adapter (Electron/Tauri), shadcn ui/, lib/
packages/protocol/src/
  stream/                    # invitation.ts, signal.ts, state.ts, internal guards.ts
```

The protocol package keeps its existing public stream exports in `src/index.ts`.

Add a new capability (discovery, remote control, screen capture) as its own folder under `features/`. Put code in `shared/` only once two features need it.

## Delivery plan

1. **Prove the hard paths.** On physical hardware, stream an iPad screen into a minimal Windows receiver. Then stream Windows into the iPad and send touch-generated mouse commands back. Measure latency, CPU, dropped frames, rotation handling, and disconnect behavior. Confirm the Windows media path and Apple capture lifecycle before building the full shell.
2. **Ship the first useful pair.** Windows + iPad, manual/QR pairing, one stream at a time, Windows remote control, visible consent and stop actions, no accounts. Add discovery after direct connections work.
3. **Add Android.** Prove capture first. Treat accessibility-based control as a separate feature with installation/distribution constraints and device testing.
4. **Harden.** Reconnection, key release, DPI/multiple displays, orientation, capture permission denial, firewall diagnostics, identity revocation, and installer/signing work.
5. **Expand from measured needs.** Audio, clipboard, multiple viewers, browser viewer, macOS/Linux, internet relay, and simultaneous streams are separate decisions.

Initial performance experiment: target 1080p at 30 fps and a measured LAN motion-to-display latency below 150 ms on named reference devices. This is a target, not a promise. Record input-to-visible-response latency separately; adjust bitrate/resolution under congestion.

First release acceptance: works without internet on a normal non-isolated LAN; unknown peers cannot view or control; control requires an explicit grant; stop/revocation takes effect immediately; rotation and disconnect do not leave stuck input. Test real Windows and iPad hardware early. iOS builds require access to macOS and signing tools.

## Open decisions

- Which exact iPad/iPhone, Android, and Windows versions must be supported?
- Is Windows-to-iPad screen viewing plus iPad-to-Windows control enough for the first release?
- Is screen mirroring sufficient, or is an extended Windows display required? A true extra display needs a separate driver-oriented design.
- Is initial distribution personal/sideloaded or through public app stores?
- Is system audio needed in the first release?

## Technical references

- [Tauri frontend configuration](https://v2.tauri.app/start/frontend/) recommends Vite for SPA frontends.
- [Apple ReplayKit security](https://support.apple.com/en-gb/guide/security/seca5fc039dd/web) describes broadcast capture and upload extensions. Recheck current capture APIs and deployment availability against the selected minimum iOS version before implementation; newer ScreenCaptureKit documentation also needs evaluation.
- [Android MediaProjection](https://developer.android.com/media/grow/media-projection) documents capture consent and foreground execution requirements.
- [Android AccessibilityService](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService) documents gesture dispatch capabilities. This does not establish app-store eligibility or universal device support.
- [Windows capture](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture) provides native frame capture.
- [Windows SendInput](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput) documents input injection and UIPI restrictions.
- [WebRTC peer connections](https://webrtc.org/getting-started/peer-connections) describes signaling and ICE negotiation.
