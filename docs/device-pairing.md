# Local device pairing

Implemented on Electron main `7c377e5`, adapting reviewed pairing code from `fb22c83`. The existing Android-to-Windows test-video stream was reported working by the user. This change keeps its native `connect(invitation)`, `start(bitrateMbps)`, `stop()` and status events, TLS pinning and WebRTC media path.

## Run updated clients

From this worktree, run `pnpm install --frozen-lockfile`, then `pnpm dev:desktop`. This builds the Electron renderer and Rust sidecar for the current OS. `pnpm dev:desktop:tauri` retains the Tauri path where its WebRTC engine is supported.

Rebuild the phone development client after installing dependencies: `pnpm --filter @duodesk/mobile exec expo run:android` on an Android build host, or `pnpm --filter @duodesk/mobile exec expo run:ios` on macOS. Existing signing/device setup is in the root README. Start Metro with `pnpm dev:mobile`. A JavaScript update alone cannot add `pairRequest`/`pairClose` to an older installed binary.

## Connect a phone

1. Open the Electron receiver on Linux, macOS or Windows, or the retained Tauri host. Choose the Wi-Fi or Ethernet address connected to the same router as the phone. Nothing is selected automatically.
2. Choose **Create pairing code**. The desktop shows its address including a port, such as `192.168.1.20:39871`, and six digits. Use the actual values shown.
3. In the mobile **Stream test** tab, scan the desktop pairing QR to fill the address and code, then choose **Verify code and connect**. You can also enter both values manually.
4. Once ready, select the bitrate and start the video. Stop or leave the mobile screen to disconnect. Create a fresh code to reconnect.

Rebuild both the desktop and mobile development clients for this change. Expo Go and older mobile binaries lack the native pairing transport. iOS and Android use the same protocol.

The dropdown includes interface names supplied by the OS. Local/private IPv4 addresses come first. Common VPN, container and virtual adapter names are labelled **Likely virtual / VPN**; this is a name-based hint, not a claim that an adapter is physical or reachable. Loopback and public addresses cannot be selected. IPv6 and public-address LANs are not supported by this flow. Link-local addresses are shown separately and only work when both devices have a route to that link. Refresh after changing Wi-Fi or adapters. Creating a session checks the chosen address again and binds only that address.

The phone uses the desktop address, not its own address. A guest Wi-Fi network, client isolation or VPN may prevent access. Allow DuoDesk and its signaling sidecar through the desktop firewall on a private network. Both bootstrap and TLS signaling use temporary TCP ports; media uses WebRTC's dynamic ports. No internet, hosted signaling, STUN or TURN is needed. Connection refusal, an outdated port, firewall filtering and network isolation cannot always be distinguished reliably. Mobile separates failure to reach the address from failure during code verification and gives steps for both; it does not claim to detect the phone subnet. Do not expose either listener through port forwarding.

The pairing QR contains only the desktop's local address and temporary six-digit code. Scanning fills the same fields as manual entry; both paths use the same authenticated pairing protocol. The QR does not contain the invitation, token, or certificate fingerprint. Anyone who can see an active QR can read the code, so protect it like the displayed digits and do not post screenshots.

## Trust and protocol

Manual pairing uses SRP-6a through `@swan-io/srp` 0.2.6, with its RFC 5054 2048-bit group and SHA-256. Both roles use the same library. The fixed protocol identity is `duodesk-pair-v1`. The desktop generates an independent, uniformly sampled six-digit code with a cryptographic RNG, plus a fresh salt and verifier for each session. It does not truncate or replace the 256-bit invitation token.

The desktop QR uses a canonical `duodesk-pair://connect` URI containing version 1, one private IPv4 address and port, and exactly six ASCII digits. The shared parser rejects other schemes, extra or repeated fields, non-canonical encodings, public/DNS endpoints, and malformed codes. Old invitation JSON QR codes and paste/copy fields are no longer accepted by the mobile UI. The QR is only an autofill shortcut; it does not create a separate or weaker trust path.

A separate local TCP bootstrap carries newline-framed JSON, limited to 8192 bytes per frame and exactly two request/response rounds:

1. Phone sends `{v:1,type:"hello",public:A}`. Desktop replies `{v:1,type:"challenge",salt,public:B}`.
2. Phone sends `{v:1,type:"proof",proof:M1}`. After verifying M1, desktop replies `{v:1,type:"verified",proof:M2,nonce,encrypted}`.

Public values are exactly 512 lowercase hexadecimal characters; salt and proofs are 64. The library rejects zero public values modulo N. Messages have exact fields and version checks. The client verifies the server proof before decrypting anything.

The library's 32-byte session key encrypts the complete invitation using AES-256-GCM from `@noble/ciphers` 1.3.0, with a fresh 12-byte nonce and UTF-8 `duodesk-pair-v1` as associated data. `encrypted` includes the authentication tag. Each session key encrypts one invitation only. The phone validates the invitation's version, fields, lifetime and endpoint, and requires its host to match the entered private IPv4 address. It then calls the existing native sender, which checks the exact SHA-256 certificate fingerprint before sending the full random invitation token over TLS. WebRTC's authenticated encrypted negotiation/media remain unchanged.

The bootstrap socket is deliberately not TLS. SRP public values/proofs can travel over an untrusted channel; the code and verifier never travel on it. The invitation, token and certificate fingerprint travel only inside authenticated encryption. There is no trust-on-first-use certificate acceptance and no disabled certificate check. An attacker can relay an exchange but cannot change the authenticated invitation or subsequently impersonate the pinned desktop.

## Bounds and limits

- Manual bootstrap accepts at most eight TCP connections per session, including malformed frames and slow clients. Each exchange has a 15-second total deadline. A new server ephemeral is generated for every challenge.
- The code and invitation expire together after 120 seconds. Expiry and cancellation close listeners and active bootstrap sockets. The mobile transport bounds connect/read waits and response allocation; it closes on background, navigation, Stop, error and completion.
- The first successful code proof consumes pairing. The bootstrap listener closes even if invitation delivery fails. The first authenticated TLS peer consumes the invitation and closes the TLS listener. A consumed code never starts a second stream.
- QR and manual entry use the same eight-connection bootstrap budget and lockout. There is no alternate QR listener after the code is locked. With eight online guesses against the uniform six-digit code, success probability is at most 8 in 1,000,000 per displayed code. Anyone who can see the display or QR can read the code; an attacker can also exhaust attempts or occupy the LAN to deny service.
- SRP protects against passive offline guessing of the code from a network transcript. The in-memory verifier is short-lived, but its compromise permits offline guessing of this low-entropy code. Nothing is persisted as a remembered pairing or trusted device.
- This is an established PAKE construction and library, not a claim of a product security audit. The SRP library uses JavaScript big-integer arithmetic and does not promise constant-time operation. This implementation does not address local-process/timing side channels or device compromise. A dedicated security review is still appropriate before broad release.

The pinned pnpm patch only changes the SRP library's crypto-provider lookup to lazy `globalThis.crypto`, avoiding its Node `require("crypto")` in Metro. SRP arithmetic, groups, derivation and proofs are unchanged. Mobile supplies only the required SHA-256 digest and secure random API through Expo Crypto 58.0.7. No algorithm falls back to `Math.random`.

## Integration with screen capture work

Capture sources, WebRTC setup, bitrate control and native sender signatures are unchanged. The mobile QR scanner fills the address and code fields; manual entry remains available. Preserve cancellation guards and the other thread's source selector when changing this screen. New native module methods are `pairRequest(address,message,fresh)` and `pairClose()`; they use a separate queue and never touch video frames or capture consent. Preserve their background/destruction cleanup.

The invitation and signaling wire formats remain v1. The bootstrap has an independent v1 envelope. `stream_start` returns `{invitation,address}` to desktop UI; `stream_interfaces` returns interface metadata. Both Electron and Tauri use `src/host/index.ts`. Electron validates `stream_pair_reply` at its isolated IPC boundary and dispatches it to the Rust sidecar; its crash tracking uses the returned invitation session ID. Rust relays bounded bootstrap frames to the desktop SRP implementation through `pairing` events and receives `stream_pair_reply` commands. Request IDs prevent late replies from being used by another socket. `pairingstatus` reports consumption/lockout. The native sender still receives the authenticated invitation internally after SRP; the mobile UI no longer accepts old invitation QR or JSON.

## Validation on this branch

- Frozen pnpm install; protocol, desktop and mobile lint/type checks passed. The lockfile preserves Electron dependencies and adds only the pairing libraries, their transitive `jsbn`, Expo Crypto and the pinned crypto-provider patch.
- 23 automated tests passed: seven shared protocol tests, five desktop unit tests, eight Rust tests and three real-sidecar integration tests. Coverage includes wrong code, proof/ciphertext tampering, malformed input, one-use authentication, eight-attempt lockout, expiry, cancellation, process exit and port cleanup.
- The new sidecar integration runs both production SRP roles over actual TCP, recovers the encrypted invitation, compares its authenticated certificate pin with the live TLS server certificate, rejects a wrong code and confirms the consumed bootstrap listener closes.
- Desktop production build, signaling Clippy with warnings denied and retained Tauri `cargo check --locked` passed on Linux.
- Real sandboxed Electron smoke passed with the authorized X11 session: explicit adapter selection, UI-generated six digits, collapsed diagnostics, preload/host IPC, session stop, and decoded Chromium loopback video. The H.264 VideoReceiver fixture passed at 640 × 360 with ten decoded frames. It logged an initial decoder error and four dropped frames; this is a functional check, not a media-quality measurement.
- The initial shell had no `DISPLAY`, and `:0` denied X authorization. Running with `DISPLAY=:10` and the existing user Xauthority enabled the real Electron checks without disabling its sandbox.
- Browser presentation inspection with synthetic props confirmed disabled loopback, collapsed diagnostics, and the code within a 1280 × 800 viewport. These checks do not prove physical network reachability.
- Expo production exports passed for Android, iOS and web. Android prebuild/autolinking and `:test-video:compileDebugKotlin` passed with the installed JDK 17 and SDK 37. This checks the sender and pairing module; no full APK was built or installed. Existing dependency/Gradle deprecation warnings and a pre-existing VideoSender parameter-name warning remain.
- No macOS Swift compilation, Windows/macOS build/package validation, physical phone test or new Android-to-Windows streaming test was performed. The earlier user-tested clip result belongs to the old flow. Recheck code and QR pairing, wrong-code lockout, foreground/background, navigation/Stop, firewall prompts and test-video playback on actual desktop plus Android and iOS devices.
- Production dependency audit reports existing advisories in `uuid`, `node-forge` and `braces`; none of their versions changed. It reports no advisories for the new pairing dependencies. This is not a product security audit.

## Combined redesign validation

After integrating presentation from `0d4cf9d`, the combined desktop production build, frozen install, lint, unit tests and all three real-sidecar integration tests passed. Both real Electron checks passed: `test:ui` exercised explicit selection, six-digit creation, the collapsed pairing QR and stop; `test:electron` also decoded Chromium loopback video. The H.264 fixture passed again at 640 × 360 with thirteen decoded frames, two dropped frames and the same initial decoder warning. This integration changes desktop presentation and dependencies only; pairing App/host/protocol/native logic is preserved. No new physical-device or cross-platform build claim is implied.

## Desktop presentation integration

`App.tsx` owns network enumeration, selected IP, PAKE server state, sidecar replies and video receiver lifecycle. `components/receiver-workspace.tsx` exports `ReceiverWorkspaceProps` and renders the UI. The shadcn presentation from `0d4cf9d` is integrated while preserving this branch's App logic. Network settings collapse during a session; address/code is primary, the compact address/code QR is expandable, and empty or expired codes are hidden. The optional `pairing` prop contains `address`, `code` and display-only `status`. Empty code means consumed or locked; never regenerate it in presentation. `interfaces` already contains OS names and `selectable`; do not adapt the new host response as a string array.

## QR autofill update

Protocol tests, desktop/mobile lint and type checks, desktop renderer build, and mobile Android/iOS/web exports passed after replacing the legacy invitation QR/JSON paths. The Electron UI smoke verified the six-digit code, collapsed pairing QR, removal of invitation textareas, stop behavior, video controls, and fullscreen. No physical phone camera scan or new Windows/macOS compilation was performed for this update.

## References

- [SRP library and API](https://github.com/swan-io/srp), including its proof/parameter implementation.
- [RFC 5054](https://www.rfc-editor.org/rfc/rfc5054), SRP groups and security considerations. This app uses the library's SRP-6a application protocol, not the RFC's TLS-SRP cipher suites.
- [Noble ciphers](https://github.com/paulmillr/noble-ciphers), AES-GCM implementation.
- [Expo Crypto 58](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/), mobile digest and random APIs.
