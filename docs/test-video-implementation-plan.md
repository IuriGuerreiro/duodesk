# iPad to Windows test-video implementation

Status: approved and implemented locally. Native compilation and physical-device acceptance remain pending; see test-video-validation.md.
Goal: stream a bundled silent clip from a foreground iPad app into the Windows Tauri app over the LAN.
Initial target: 1920×1080 at 30 fps, H.264 where both peers support it, adjustable bitrate. Quality and hardware acceleration must be measured.

1. **Prove native compatibility before building the feature.**
   Evaluate a pinned react-native-webrtc release and its Expo config plugin against SDK 58 / RN 0.88.
   Verify how a custom native video source attaches to its peer connection; ordinary video playback is not a sendable track.
   Gate: an EAS-built client installs on the real iPad and sends native test frames to a minimal receiver. If integration fails, record the failure and revise the dependency choice before continuing.
2. **Define the session protocol in `packages/protocol/src/`.**
   Add runtime-validated, versioned pairing, offer, answer, ICE candidate, stop, and error messages with bounded payloads.
   Define one sender/receiver session and states: idle, connecting, streaming, stopped, failed. Reject stale-session messages and queue ICE until the remote description is set.
3. **Add local signaling in `apps/desktop/src-tauri/src/signaling/`.**
   Use a Rust WebSocket listener on a selected LAN interface, plus Tauri commands to start/stop it and display connection details.
   Pair through an expiring, one-use QR invitation carrying a high-entropy secret and certificate fingerprint. Use TLS with native certificate pinning on iPad; no global certificate bypass.
   Authenticate before relaying signaling to the local webview. Keep secrets out of logs, limit connection attempts, and close the listener when stopped. Document Windows firewall access.
4. **Build the Windows receiver in `apps/desktop/src/streaming/`.**
   Use WebView2 RTCPeerConnection with a receive-only video transceiver and an HTML video element.
   Accept the iPad offer, negotiate supported codecs, exchange ICE, and show connection/errors/fullscreen controls. Use direct LAN candidates without public STUN/TURN.
   Explicitly release peer connections, media references, and event listeners on stop, disconnect, and window teardown.
5. **Implement the clip source in `apps/mobile/modules/test-video/`.**
   Add a local Expo native module using AVFoundation to decode a bundled, redistributable MP4 into native pixel buffers.
   Pace frames by presentation timestamps, loop with monotonic stream timestamps, and drop overdue frames instead of building a queue. Never send frame buffers through JavaScript.
   Connect this source to the verified WebRTC integration, reusing its encoder pipeline. Keep native ownership explicit to avoid duplicate WebRTC frameworks or incompatible track objects.
6. **Add the sender route at `apps/mobile/src/app/stream-test.tsx`.**
   Scan the invitation using an SDK-compatible camera module; provide manual entry of the full invitation as fallback.
   Expose Connect, Start, Stop, connection state, and errors through a small session-module interface. Send video only; pause/stop explicitly when the app backgrounds.
   Configure LAN/camera permissions and any scoped transport settings through Expo configuration/plugins. Preserve web export with a native-only feature fallback.
7. **Add diagnostics and meaningful checks.**
   Show actual codec, resolution, fps, bitrate, packet loss, and available encode/decode statistics. Do not label round-trip time as end-to-end video latency.
   Test protocol validation, expiry/replay rejection, negotiation ordering, teardown, and reconnect. Run root lint/typecheck/build and relevant Rust checks; update CI for the new modules.
8. **Validate on physical hardware and document the result.**
   Build through EAS after native changes. Test Windows WebView2 and the real iPad on the same LAN, including a session with no internet access.
   Require first-frame playback, 15 minutes without growing delay or memory, repeated start/stop/reconnect, and rejection of invalid invitations. Record achieved quality and failures instead of assuming targets passed.
   Write setup and results in `docs/test-video-validation.md`. Commit coherent changes after checks; native device validation remains pending until hardware/signing access is available.

Next milestone: implement ReplayKit broadcasting as another native frame source. Its extension owns its own streaming lifecycle; it cannot rely on the foreground app's peer connection surviving background suspension.
Excluded here: screen capture, audio, remote control, discovery, internet relays, Android sender support, and a native Windows renderer unless WebView2 fails the measured requirements.
Before the physical-device gate: obtain iPad model/iPadOS version, Apple Developer signing access, EAS project setup, and a Windows test machine.
References: [WebRTC native module](https://github.com/react-native-webrtc/react-native-webrtc), [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/), [local native modules](https://docs.expo.dev/modules/get-started/).
