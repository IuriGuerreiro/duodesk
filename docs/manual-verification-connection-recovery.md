# Verify connection recovery

Use current desktop and Android development builds on separate physical devices.
Repeat each network case with phone-to-desktop and desktop-to-phone sharing.
Record OS versions, outage duration, whether signaling survived, and the resulting action.

## Expected limits

- Media interruption gets a three-second grace period, then at most two ICE restart attempts.
- Each attempt lasts at most eight seconds, with a two-second gap. The overall interruption deadline is 25 seconds.
- Reconnect on the sharing device spends the same attempt budget. Stop cancels recovery on either device.
- A closed signaling socket needs fresh pairing. Neither a consumed code nor its invitation can reconnect.
- Invitation expiry limits admission. An established connection can continue beyond 120 seconds.

## Device checks

1. Share for more than two minutes. Verify that the consumed code stays hidden and sharing continues.
2. Interrupt phone Wi-Fi for one second, then five seconds. Expect recovery or a clear Pair again action if signaling closed.
3. Where the router permits it, interrupt only media traffic while keeping signaling connected. Verify ICE recovery without another capture prompt.
4. Leave Wi-Fi unavailable for at least 30 seconds. Verify terminal guidance, released capture, and no endless spinner or retries.
5. Restore Wi-Fi after terminal failure. Verify that sharing does not restart by itself. Pair with a new code and start again.
6. Press Stop from each peer during grace, negotiation, and the gap between attempts. Restore the network and verify no session or capture returns.
7. Allow phone control, begin a gesture, then interrupt the network. Verify no queued gesture runs after recovery. Control must remain off until a new explicit Allow.
8. Revoke control during recovery and disable Accessibility in settings. Verify that reconnecting or re-enabling the service never grants control.
9. Rotate the phone before and during recovery. Verify the picture, touch mapping, and rejection of gestures from the old geometry.
10. Stop Android capture using the system indicator during recovery. Verify cleanup and no reused consent intent. A new share must request consent.
11. Stop desktop capture through the system UI during recovery. Verify terminal guidance and no automatic capture request.
12. Background and foreground the Android sender during recovery. An active screen share may continue. Backgrounding the viewer ends watching.
13. Leave and return to the sender screen during recovery. Confirm the active screen share survives and status is current. Lock the phone and verify system capture revocation if applicable.
14. Repeat supported clip-sender cases on iOS. Backgrounding stops its session. iOS screen sharing and desktop viewing remain unsupported.
15. Try an expired code, a consumed code, and an unreachable desktop. Verify useful guidance without automatically retrying pairing.
16. Pair mixed old and new builds. An old peer may reject restart or stop immediately; the new peer must release capture and offer fresh pairing.

## Automated checks

Run protocol, desktop, and mobile unit tests, Rust signaling tests, Android module unit tests, lint, and type checks.
Run `pnpm --filter @duodesk/desktop test:recovery` with a desktop display. It starts its own local Vite server.
That smoke test uses real Chromium WebRTC and canvas video with an injected outage notification. It proves restart negotiation, continued decoding, one capture request, and return to connected status. It does not prove Wi-Fi behavior or OS capture consent.

Physical-device checks and an Xcode build must be recorded separately. Automated browser and JVM results do not substitute for them.
