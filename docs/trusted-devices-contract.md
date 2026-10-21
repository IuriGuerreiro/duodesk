# Trusted devices contract

Backend owner owns protocol, Electron and Rust signaling. Android and renderer stay with their respective implementers. This contract preserves v1 pairing and invitations.

## Architecture decision

Compared two designs against the existing host. A second authenticated streaming protocol would duplicate session routing, stop behavior and invitation expiry. Chosen design adds enrollment to the paired stream and a separate pinned TLS WebSocket reconnect listener. Reconnect produces an ordinary v1 invitation and replaces the host's active Session. Existing stream_send and stream_stop keep their meaning.

Electron owns encrypted identity and approved device persistence. Rust owns bounded network state, pending enrollment and signature verification. No private key crosses renderer IPC or touches plaintext files. The listener starts OFF on each app/host start. No IP address grants trust.

## Encodings

All JSON uses exact camelCase fields. All hex is lowercase. phoneId is SHA256 of the 65-byte uncompressed SEC1 P256 public key, encoded as 64 hex characters. publicKey is those 65 bytes as 130 hex characters, starting 04. fingerprint is SHA256 of desktop DER certificate, 64 hex characters. Signatures are ECDSA P256 SHA256, ASN.1 DER, encoded as hex. nonce is 32 random bytes as 64 hex characters.

## Enrollment on the existing authenticated pinned stream

After receiving ordinary paired, an explicitly opted-in phone sends:

```json
{
  "v": 1,
  "sessionId": "<32hex>",
  "type": "trust_enroll",
  "phoneId": "<64hex>",
  "name": "My phone",
  "publicKey": "<130hex>"
}
```

Name is 1..80 UTF-8 bytes. Desktop presents pending approval. Request IDs are random 32hex and bound to this authenticated session. Pending requests expire after 120 seconds or when the stream ends. No phone persistence before the following commit acknowledgement. On explicit desktop approval Electron first durably saves the public key, then tells Rust to commit and acknowledge on the same stream:

```json
{
  "v": 1,
  "sessionId": "<32hex>",
  "type": "trust_committed",
  "phoneId": "<64hex>",
  "fingerprint": "<64hex>",
  "address": "192.168.1.2:42889"
}
```

Reject/error uses {v:1,sessionId,type:"trust_rejected",phoneId,reason}. An unsupported old peer closes/rejects this extension. Timeout, close or unsupported messages NEVER count as enrollment. The phone saves fingerprint, phoneId, address and Keystore alias only after matching trust_committed. The desktop listener may be OFF; saving does not enable it. Default port is 42889, persisted by Electron. Address is manually editable on mobile.

## Reconnect listener

Connect wss://<saved address>/ and verify the saved certificate fingerprint BEFORE sending identity or proof. Use the same persisted cert for listener and resulting streaming Session. Exact messages, without sessionId:

```json
{"v":1,"type":"trust_connect","phoneId":"<64hex>"}
{"v":1,"type":"trust_challenge","phoneId":"<64hex>","fingerprint":"<64hex>","nonce":"<64hex>"}
{"v":1,"type":"trust_proof","phoneId":"<64hex>","signature":"<DER hex>"}
{"v":1,"type":"trust_invitation","invitation":{"v":1,"sessionId":"<32hex>","url":"wss://.../","token":"<64hex>","fingerprint":"<64hex>","expiresAt":123}}
```

The signed bytes are concatenation of ASCII `DuoDesk trusted reconnect v1\n`, raw nonce32, raw desktop fingerprint32, raw phoneId32. No delimiters, JSON, hex text or pre-hash. Android Signature.getInstance("SHA256withECDSA") hashes these bytes once. Challenge expires after 30 seconds on a monotonic clock, is single use and belongs only to its TLS connection. Registry and enabled state are checked again when proof succeeds. Invalid/replayed/expired/revoked/disabled attempts close without invitation. Use existing connect(invitation) after successful response. Listener has bounded concurrency and handshake/read deadlines.

## Renderer IPC

Existing window.duoDesk.invoke/subscribe transport stays. Commands:

- trust_status, no args. Returns TrustStatus below.
- trust_allow({ip,allow}). Explicit local IPv4 selection. true enables listener, false disables it and cancels pending reconnects. Returns TrustStatus.
- trust_approve({requestId,approve}). Explicit desktop decision. Returns TrustStatus. Approval fails unless secure persistence succeeds.
- trust_revoke({phoneId}). Removes persisted trust and immediately updates Rust's current registry. Returns TrustStatus.

TrustStatus is {available:boolean,reason:string|null,enabled:boolean,address:string|null,fingerprint:string|null,devices:TrustedPhone[],pending:PendingTrust[]}.
TrustedPhone is {phoneId,name,publicKey,createdAt:number}. PendingTrust is {requestId,phoneId,name,publicKey}.

Events:

- {kind:"trust_status",status:TrustStatus} after changes.
- {kind:"trust_enrollment",request:PendingTrust} when authenticated phone asks.
- {kind:"trust_reconnected",phoneId,invitation} before new Session emits ready/signals. Renderer replaces its current invitation and uses ordinary receiver signaling. Host routes stream_send and stream_stop to this Session.

Secure storage unavailable or Linux basic_text means available:false with reason, no persistent trust or reconnect. Ordinary pairing still works with ephemeral identity. A retained Tauri build continues supporting ordinary pairing; trusted devices are Electron-only until equivalent OS secure storage is implemented.

## Security references

- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) documents Linux basic_text as a hardcoded plaintext-password fallback. Reject it even when isEncryptionAvailable returns true.
- [ring signature formats](https://docs.rs/ring/latest/ring/signature/index.html) defines P256 SHA256 ASN.1 ECDSA and uncompressed public keys.
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore) keeps private signing material outside the application process.

## Implementation checkpoint

Blocking first step was this contract. Independent mobile/UI work uses only these messages and IPC. Electron is the single persistence writer; Rust serializes registry and Session ownership. One backend owner handles these coupled changes. Verification must use real TLS and actual signature generation, plus injected secure-storage tests.
