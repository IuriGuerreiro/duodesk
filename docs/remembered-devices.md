# Remembered devices

Remembering saves a cryptographically authenticated device identity after pairing and approval on both devices. Names and addresses are hints. Each new sharing session still needs a request and acceptance. Screen capture and remote control keep their separate session grants.

## Use remembered devices

1. Rebuild both apps, including the mobile native module. Pair with the QR or six-digit code.
2. Open **Remembered devices** and choose **Remember paired device**. Approve on the other device. Enter a friendly local name if wanted.
3. On desktop, explicitly choose a local interface and enable remembered connections. This choice persists. DuoDesk rechecks that interface after restart and follows address changes on that interface.
4. Keep both apps open. Android and iOS discover the desktop through Bonjour/mDNS and hold a pinned, authenticated waiting connection. Backgrounding the phone closes that waiting connection.
5. Choose **Connect to PC**, **View phone**, or **Share desktop**. The other device accepts the new session. Phone screen sharing still starts through the existing capture flow. iOS supports its existing test-clip sender only.
6. If discovery is blocked, enter the remembered-device address shown on desktop. If authentication fails or the identity changed, pair again with a fresh code.

**Rename** changes only your local label. **Forget** immediately blocks the relationship, cancels its pending requests, and ends its current session. It removes local trust durably and notifies the other peer when reachable. An offline peer can retain a stale entry, but mutual authentication fails. If durable removal fails, the error explains that blocking only lasts until the app closes; retry Forget after unlocking storage.

Remembered connections accept private or link-local IPv4 LAN addresses. Existing code/QR pairing still accepts its existing Tailscale addresses. There is no account sync, relay, background mobile listener, or unattended access.

## Protocol and storage reference

- Pairing v2 requests `trust-v1`. The SRP-authenticated encrypted reply contains the unchanged v1 invitation and the agreed features under a v2 AES-GCM associated-data label. An older desktop closes the v2 hello; the phone retries v1 on a fresh connection. This spends one extra connection from the eight-attempt budget. No fallback follows an accepted challenge or failed proof.
- Enrollment runs inside the consumed-token session's pinned TLS WebSocket. Rust and Kotlin/Swift own keys and proofs. Both peers sign purpose, signer role, session ID, certificate fingerprint, token hash, both keys, and both nonces. JavaScript receives status and user-consent actions, never private keys.
- P-256 public keys use uncompressed SEC1 points encoded as lowercase hex. Identity fingerprints hash those 65 bytes. Signatures use ASN.1 DER ECDSA with SHA-256. Shared vectors live in `packages/protocol/test/vectors/trust-v1.json`.
- Enrollment writes pending records after local approval and proof verification. A peer's saved acknowledgement permits activation. Pending records never authenticate and are discarded on disconnect or restart. A lost final reply can leave asymmetric records; reconnect then fails into fresh pairing.
- The remembered endpoint uses the desktop identity as its TLS key. Mobile pins the public key independently of certificate renewal. The phone signs a fresh server challenge bound to both identities and a client nonce. No TLS-exporter API or invitation-token reuse is involved.
- The idle link grants no session permission. Both users approve a request before the host creates a fresh expiring, one-use invitation. Delivery waits until the desktop media handler is ready. Electron main and Rust enforce approval; a network message alone cannot activate capture.
- `_duodesk-trust._tcp` advertisements contain a random instance, display name, version, role, and endpoint. They contain no stable identity or credential. Candidate counts, authentication concurrency, frame sizes, requests, and handshake waits are bounded.
- Desktop keeps up to eight remembered phones so the complete trust record fits [Windows credential storage](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentiala). It uses explicit OS adapters through [Rust credential stores](https://docs.rs/keyring/latest/keyring/): Windows Credential Manager, macOS Keychain, and Linux Secret Service. Metadata is separate. A slow or unavailable vault disables remembering while preserving code pairing. There is no plaintext fallback.
- Android uses [Keystore](https://developer.android.com/privacy-and-security/keystore) signing and encryption keys. Encrypted trust records and the installation marker use the app's non-backed-up storage. iOS uses Keychain with [WhenUnlockedThisDeviceOnly](https://developer.apple.com/documentation/security/ksecattraccessiblewhenunlockedthisdeviceonly?changes=_3) and a non-backed-up installation marker. Keys lost or replaced require pairing again.
- Issue #24 recovery remains within an existing session. After recovery fails, use the remembered-device list to request a new session. Trust never restores a revoked capture/control grant.

## Verify changes

Run protocol, desktop, and mobile tests, lint, and type checks. Run signaling Rust tests and Clippy. `pnpm --filter @duodesk/desktop test:trust` builds a debug-only storage fixture and exercises real SRP, pinned TLS, restart, replay rejection, both request directions, single-use admission, and Forget. Production builds do not include that storage fixture; release builds with `test-storage` are rejected.

On Android, run `:test-video:compileDebugKotlin` and `:test-video:testDebugUnitTest` in the generated native project. On macOS, run `pnpm --filter @duodesk/mobile test:ios-trust` for Swift vectors and enrollment checks, then build the iOS development client.

Before release, check physical Android/iOS devices with Windows/macOS/Linux: either side initiates, rename/restart, address changes, blocked multicast, manual address fallback, background/foreground, changed keys/reinstall, Forget while sharing or awaiting consent, and denied/revoked capture/control permission. Linux automated checks do not establish physical-device behavior or an iOS build. Physical iOS testing also requires the Apple developer setup.
