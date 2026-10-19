# Desktop-to-phone streaming spike

Question: can Electron on this Linux box capture the screen and send it over WebRTC, so a phone can be the viewer?

Answer: yes on the sending side. The Android decode half is not tested.

## What was run

A throwaway Electron app (not committed). It called `getDisplayMedia` through `session.setDisplayMediaRequestHandler`, with the sandbox on. It sent the track over a loopback `RTCPeerConnection` pair for 12 seconds per codec, with a moving canvas on screen so the capture had motion.

- Electron 44.8.0 on X11 (xrdp session, `:10.0`), 1920x1080, 4 cores.
- `desktopCapturer` found one source: `screen:297:0` "Entire screen".
- Wayland is not available on this machine. The Wayland and PipeWire portal path is unverified.

## Results

| Codec | Encoder             | Sent               | Bitrate   | Quality limited by encoder |
| ----- | ------------------- | ------------------ | --------- | -------------------------- |
| H.264 | OpenH264 (software) | 1920x1080, ~21 fps | ~1.0 Mbps | no                         |
| VP8   | libvpx (software)   | 1920x1080, ~20 fps | ~1.3 Mbps | no                         |
| VP9   | libvpx (software)   | 1920x1080, ~20 fps | ~1.5 Mbps | no                         |

- Capture was requested at 30 fps. It delivered about 20 to 23 fps. The xrdp virtual display is probably the limit. A physical X11 display may do better. This is not measured.
- Electron process CPU was 26 to 30 percent of one core. That figure also includes the loopback decoder and the canvas animation in the same renderer, so it overstates real sender cost.
- H.264 worked. `RTCRtpSender.getCapabilities` lists H.264 and the default negotiated codec was VP8. Forcing H.264 needs `setCodecPreferences`.
- The first H.264 run logged one `avcodec_send_packet` error while the loopback decoder fell back from VAAPI to FFmpeg. Frames decoded afterwards (208).

## Consequences for the plan

- No native Linux capture code is needed on X11.
- The permission handler must pick the screen source itself. There is no picker UI in the handler.
- Offer H.264 first and VP8 second. The Android `DefaultVideoDecoderFactory` has no software H.264 decoder, so a phone without a hardware H.264 decoder will answer with VP8. This is from reading the code. It is not tested.

## Not verified

- Anything on the phone: decode, render, latency, battery.
- Wayland and PipeWire portal capture.
- Windows and macOS capture.
- Capture frame rate on a physical display.

## Manual check on the phone

See [desktop-to-phone screen sharing](desktop-to-phone-screen-share.md) for the phone test steps.
