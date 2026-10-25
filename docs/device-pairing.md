# Local device pairing

DuoDesk pairs phones with the Electron receiver using a local six-digit code or QR. Android can also save an explicitly approved desktop for later reconnects.

## Run updated clients

From this worktree, run `pnpm install --frozen-lockfile`, then `pnpm dev:desktop`. This builds the Electron renderer and Rust sidecar for the current OS. `pnpm dev:desktop:tauri` retains the Tauri path where its WebRTC engine is supported.

Rebuild the phone development client after installing dependencies: `pnpm --filter @duodesk/mobile exec expo run:android` on an Android build host, or `pnpm --filter @duodesk/mobile exec expo run:ios` on macOS. Existing signing/device setup is in the root README. Start Metro with `pnpm dev:mobile`. A JavaScript update alone cannot add `pairRequest`/`pairClose` to an older installed binary.

## Connect a phone

1. Open the Electron receiver on Linux, macOS or Windows, or the retained Tauri host. Choose the Wi-Fi or Ethernet address connected to the same router as the phone. Nothing is selected automatically.
2. Choose **Create pairing code**. The desktop shows its address including a port, such as `192.168.1.20:39871`, and six digits. Use the actual values shown.
3. In the mobile **Stream test** tab, scan the desktop pairing QR. A valid QR verifies the code and connects at once, with no second tap. If it fails, the address and code stay filled in so you can retry or correct them, or scan a new QR. You can also enter both values manually and choose **Connect to PC**.
4. Once ready, select the bitrate and start the video. Stop sharing ends the video while keeping the desktop paired. Disconnect ends the link. After disconnecting, use a fresh code or a saved desktop as described below.

Rebuild both the desktop and mobile development clients for this change. Expo Go and older mobile binaries lack the native pairing transport. iOS and Android use the same protocol.

The dropdown includes interface names supplied by the OS. Local/private IPv4 addresses come first. Common VPN, container and virtual adapter names are labelled **Likely virtual / VPN**; this is a name-based hint, not a claim that an adapter is physical or reachable. Loopback and public addresses cannot be selected. IPv6 and public-address LANs are not supported by this flow. Link-local addresses are shown separately and only work when both devices have a route to that link. Refresh after changing Wi-Fi or adapters. Creating a session checks the chosen address again and binds only that address.

The phone uses the desktop address, not its own address. A guest Wi-Fi network, client isolation or VPN may prevent access. Allow DuoDesk and its signaling sidecar through the desktop firewall on a private network. Both bootstrap and TLS signaling use temporary TCP ports; media uses WebRTC's dynamic ports. No internet, hosted signaling, STUN or TURN is needed. Connection refusal, an outdated port, firewall filtering and network isolation cannot always be distinguished reliably. Mobile separates failure to reach the address from failure during code verification and gives steps for both; it does not claim to detect the phone subnet. Do not expose either listener through port forwarding.

The pairing QR contains only the desktop's local address and temporary six-digit code. Scanning fills the same fields as manual entry and starts the same connect step; both paths use the same authenticated pairing protocol. The QR carries no expiry, so an expired or used code is reported by the desktop as a failed code check. The QR does not contain the invitation, token, or certificate fingerprint. Anyone who can see an active QR can read the code, so protect it like the displayed digits and do not post screenshots.

## Remember an Android phone

Rebuild both the Android development client and Electron app. iOS, older mobile binaries, and the retained Tauri host continue to support code pairing. They do not support remembered devices in this delivery.

1. On Android, turn on **Remember this desktop** before scanning the QR or entering the code. Remember is an explicit choice for that pairing.
2. Complete ordinary code pairing. On the desktop, approve **Remember phone** for the phone that just paired.
3. Wait for the phone to confirm that the desktop was saved. Closing the app, disconnecting, declining, or timing out during approval does not count as success.
4. On the desktop, choose the network address and turn on **Allow reconnects**. This switch starts off each time the desktop host starts.
5. On Android, open saved desktops and choose **Reconnect**. No QR or code is needed. The desktop shows a visible notice when the trusted phone connects.

Remembering a phone grants permission to reconnect for streaming. It does not grant remote control or screen-capture permission. Start sharing separately on the phone. Android still presents its capture-consent dialog, and Stop still ends sharing.

The saved address is a connection hint. If the desktop changes IP address, update the saved address on the phone using the reconnect address shown by the desktop. The reconnect port differs from the temporary code-pairing port. Discovery names and IP addresses never establish trust. This delivery has no stable discovery ID and does not reconnect automatically at app startup.

A transient connection failure retries after 1, 2, and 4 seconds, then shows an offline state with Retry. Cancel stops the active request and further retries. Authentication failures stop immediately and show **Needs re-pairing**. A closed listener or an unreachable desktop can look like an offline network failure.

## Revoke, forget, and recover

- On the desktop, choose **Revoke** next to a trusted phone. Subsequent reconnect proofs are rejected immediately, including proofs for challenges issued before revocation. Revocation does not authorize or start any other action.
- On the phone, choose **Forget** to remove the saved desktop metadata and its exclusively owned signing key. To revoke the phone's permission on the desktop too, use Revoke there.
- Turn off **Allow reconnects** to reject new trusted reconnects. Turn it back on after choosing the intended local interface. An existing stream still has its separate Stop control.
- If either app is reset or reinstalled, or if the desktop certificate or phone key changes, explicitly pair again with a fresh code. DuoDesk never silently replaces a saved certificate pin. Forget the old saved desktop first when needed.
- If secure storage is unavailable, ordinary code pairing still works, but persistent trust is disabled. On Linux, configure a supported keyring and restart the app. DuoDesk refuses Electron's insecure `basic_text` fallback even when Electron reports encryption available.
- If desktop identity storage is corrupt or cannot be decrypted, persistent trust stays unavailable. Recover the OS keyring or explicitly reset the application's stored data and pair again. Do not copy private keys into plaintext files.

## Trusted reconnect security

Electron encrypts the persistent desktop certificate and private key with OS-backed `safeStorage` before writing them. The private key exists in memory for TLS but is never persisted in plaintext or exposed to the renderer. Android creates a per-desktop P-256 signing key in Android Keystore. Saved desktop metadata is encrypted with a Keystore AES-GCM key and kept outside Android backup.

Enrollment travels on the already authenticated, certificate-pinned streaming channel. Desktop approval first persists the trusted public key, then sends a commit acknowledgement on that same stream. The phone saves trust only after receiving the matching acknowledgement. Interrupted delivery can leave an approved desktop entry without a saved phone entry; revoke that entry and pair again.

Before a reconnect proof is sent, Android verifies the saved SHA-256 certificate fingerprint. The proof signs a versioned fixed encoding containing a fresh 32-byte nonce, the desktop fingerprint, and the phone key identity. Rust checks the signature against the current trusted list. Challenges expire after 30 seconds, belong to one connection, and can be consumed only once. Disable and revoke invalidate pending authentication. A successful reconnect returns an ordinary v1 streaming invitation over the pinned TLS channel.

See [the wire and IPC contract](trusted-devices-contract.md) for exact encodings, field limits, and message shapes. Platform references are [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) and [Android Keystore](https://developer.android.com/privacy-and-security/keystore).

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
- SRP protects against passive offline guessing of the code from a network transcript. The in-memory verifier is short-lived, but its compromise permits offline guessing of this low-entropy code. One-time code pairing persists no secret code or verifier. Separately approved trusted-device enrollment persists the identities described above.
- This is an established PAKE construction and library, not a claim of a product security audit. The SRP library uses JavaScript big-integer arithmetic and does not promise constant-time operation. This implementation does not address local-process/timing side channels or device compromise. A dedicated security review is still appropriate before broad release.

The pinned pnpm patch only changes the SRP library's crypto-provider lookup to lazy `globalThis.crypto`, avoiding its Node `require("crypto")` in Metro. SRP arithmetic, groups, derivation and proofs are unchanged. Mobile supplies only the required SHA-256 digest and secure random API through Expo Crypto 58.0.7. No algorithm falls back to `Math.random`.

## Integration with screen capture work

Capture sources, WebRTC setup, bitrate control and native sender signatures are unchanged. The mobile QR scanner fills the address and code fields; manual entry remains available. Preserve cancellation guards and the other thread's source selector when changing this screen. New native module methods are `pairRequest(address,message,fresh)` and `pairClose()`; they use a separate queue and never touch video frames or capture consent. Preserve their background/destruction cleanup.

The invitation and signaling wire formats remain v1. The invitation carries a `direction` (`phone-to-desktop` or `desktop-to-phone`); see [desktop-to-phone screen sharing](desktop-to-phone-screen-share.md). An invitation without it is rejected. The bootstrap has an independent v1 envelope. `stream_start` returns `{invitation,address}` to desktop UI; `stream_interfaces` returns interface metadata. Both Electron and Tauri use `src/host/index.ts`. Electron validates `stream_pair_reply` at its isolated IPC boundary and dispatches it to the Rust sidecar; its crash tracking uses the returned invitation session ID. Rust relays bounded bootstrap frames to the desktop SRP implementation through `pairing` events and receives `stream_pair_reply` commands. Request IDs prevent late replies from being used by another socket. `pairingstatus` reports consumption/lockout. The native sender still receives the authenticated invitation internally after SRP; the mobile UI no longer accepts old invitation QR or JSON.

## Trusted-device verification on this branch

Run the automated checks from the repository root:

```sh
pnpm --filter @duodesk/protocol test
pnpm --filter @duodesk/desktop test
pnpm --filter @duodesk/desktop build
pnpm --filter @duodesk/desktop test:host
pnpm --filter @duodesk/desktop test:ui
pnpm --filter @duodesk/desktop test:trusted
pnpm --filter @duodesk/mobile test
cargo test --locked --manifest-path apps/desktop/src-tauri/signaling/Cargo.toml
```

`test:trusted` requires a GUI session and an available OS keyring. It uses temporary app data and a simulated phone key. It exercises production SRP, actual pinned TLS, desktop approval, encrypted storage, full Electron process restart, reconnect without code, the visible reconnect notice, and rejection after Revoke. On Linux it also starts Electron with the basic password store and checks that persistent trust is refused while ordinary pairing remains usable.

The Rust TLS tests cover wrong keys, wrong desktop identity, replay, expired challenges, proofs moved between connections, current-list revocation, and disabled listeners. Protocol tests cover exact parsing and signed byte encoding. Mobile tests cover bounded retry delays, cancellation, late results, terminal failures, opt-in enrollment, interrupted enrollment, and old native binary capability handling. These checks preserve ordinary v1 pairing and do not claim that older clients support trust extensions.

Desktop production build, Android production export, and the retained Tauri `cargo check --locked` passed. Android native Kotlin compilation and all 21 local native unit tests passed with JDK 21. The native tests use real TLS sockets and verify that a wrong certificate pin sends no phone identity or proof. They also cover signed payload bytes, rejected access, changed invitation hosts, duplicate or expired challenges, and cancellation. Protocol, desktop, and mobile lint and type checks passed.

Physical Android checks remain pending: actual Keystore persistence, capture consent, Stop, app and desktop restart, IP changes, offline Retry and Cancel, revocation, and reinstall or identity-reset recovery. These checks did not use a physical Android device. No Windows or macOS acceptance check, iOS trust feature, or automatic app-start reconnect is included.

## Earlier pairing validation

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

`features/receiver/use-receiver-session.ts` owns network enumeration, selected IP, PAKE server state, sidecar replies and video receiver lifecycle. `features/receiver/receiver-workspace.tsx` exports `ReceiverWorkspaceProps` and renders the UI; `App.tsx` composes them. The shadcn presentation from `0d4cf9d` is integrated while preserving the receiver logic. Network settings collapse during a session; address/code is primary, the compact address/code QR is expandable, and empty or expired codes are hidden. The optional `pairing` prop contains `address`, `code` and display-only `status`. Empty code means consumed or locked; never regenerate it in presentation. `interfaces` already contains OS names and `selectable`; do not adapt the new host response as a string array.

## QR autofill update

Protocol tests, desktop/mobile lint and type checks, desktop renderer build, and mobile Android/iOS/web exports passed after replacing the legacy invitation QR/JSON paths. The Electron UI smoke verified the six-digit code, collapsed pairing QR, removal of invitation textareas, stop behavior, video controls, and fullscreen. No physical phone camera scan or native Android/iOS/Windows/macOS compilation was performed for this update.

## QR auto-connect

`pairing/scan-gate.ts` turns the camera's repeated barcode events into one request: a valid QR disarms the gate synchronously, and an unreadable payload is reported once. `pairing/connect-flow.ts` is the shared connect step for scans and manual entry: local network permission, SRP code check, then the native sender, stopping if the attempt was cancelled. React Native on Android can report a system permission dialog as the app going to the background (not confirmed on a device here), so `use-sender-session.ts` ignores that signal while a dialog it opened is pending (`guardPrompt`); otherwise the attempt would be cancelled right after the user answered. The camera permission is requested once when the scanner opens. Tests: `pnpm --filter @duodesk/mobile test` covers repeated events, invalid, expired and reused codes, denied permission, cancellation, retry, and a real SRP exchange from QR to sender. A physical phone scanning a live desktop QR has not been tested.

## Nearby PCs (local network discovery)

While a pairing code is active, the desktop sidecar advertises a DNS-SD service `_duodesk._tcp` (`signaling/src/discovery.rs`, `mdns-sd` crate) on the selected interface only. Electron and Tauri share it. The record holds the bootstrap port and TXT `v=1`, `role=desktop`, a display `name` and a random per-session `id`. It never contains the code, token, invitation or certificate fingerprint. The record is withdrawn (goodbye packet) when the bootstrap closes: code used, locked, expired, cancelled or stopped. If the process is killed, the record lingers until its mDNS TTL expires; tapping it then fails like an outdated address.

Android browses with `NsdManager` (`NearbyBrowser.kt`, no subnet scanning). API 34+ uses `registerServiceInfoCallback` for address updates and loss; older versions queue `resolveService` calls. Browsing stops in the background and restarts on return. On Android 17+ (`ACCESS_LOCAL_NETWORK`), browsing starts automatically only if access is already granted; otherwise the list shows **Find nearby PCs**, which asks.

Discovery is untrusted. `@duodesk/protocol/discovery` validates each record (instance format, version, role, port, first private IPv4 among several addresses, sanitized and bounded name), dedupes by instance, replaces an older session from the same endpoint and caps the list at 16. Choosing a nearby PC only fills the address; the user must still enter the six-digit code from that PC, and the same SRP pairing runs. QR and manual entry are unchanged. iOS and web report discovery as unsupported and show no list.

Tests: protocol record/lifecycle tests, mobile controller tests (permission, denial, stale events after stop, errors), Rust unit tests and an ignored real multicast round trip (`cargo test -- --ignored browse`). A separate-process `mdns-sd` browser resolved the real sidecar's record with the bootstrap port and saw its removal on stop. Avahi on the same Linux host did not list it (local-host packets); not tested on a physical phone.

## References

- [SRP library and API](https://github.com/swan-io/srp), including its proof/parameter implementation.
- [RFC 5054](https://www.rfc-editor.org/rfc/rfc5054), SRP groups and security considerations. This app uses the library's SRP-6a application protocol, not the RFC's TLS-SRP cipher suites.
- [Noble ciphers](https://github.com/paulmillr/noble-ciphers), AES-GCM implementation.
- [Expo Crypto 58](https://docs.expo.dev/versions/v58.0.0/sdk/crypto/), mobile digest and random APIs.
