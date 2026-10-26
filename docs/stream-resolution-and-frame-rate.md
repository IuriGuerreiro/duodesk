# Stream resolution and frame rate

The sending side picks a maximum picture size and frame rate before the stream starts. This works for
phone-to-desktop (Android sender) and desktop-to-phone (desktop sender). Changing them during a live stream is
not supported yet: stop and start again.

## What the user chooses

- **Max width × max height**: a box for the long side × short side. The box turns with the screen, so
  `1280 × 720` means 720 × 1280 on a portrait phone.
- **Max fps**: a frame-rate cap. Screen capture only produces frames when the screen changes, so a still
  screen sends fewer.

The picture is scaled down to fit the box at the screen's own aspect ratio, rounded to even sizes for the
encoder. It is never scaled up. The shared rules live in `packages/protocol/src/stream/settings.ts`
(`validateStreamSettings`, `fitCapture`); the Android copy is `StreamSettings.kt` and
`computeCaptureDimensions` in `ScreenSource.kt`. Keep them in step.

## Limits and errors

| Setting | Range | Why |
| --- | --- | --- |
| Width (long side) | 320 to 3840 | 3840 × 2160 is the largest H.264 level 5.1 picture |
| Height (short side) | 240 to 2160, not above width | same |
| Frame rate | 5 to 60 | both capture paths deliver at most 60 |

Values outside these ranges are refused in the form and again natively, with a message naming the field.

- **Android** also asks the phone's hardware H.264 encoders
  ([`areSizeAndRateSupported`](https://developer.android.com/reference/android/media/MediaCodecInfo.VideoCapabilities#areSizeAndRateSupported(int,%20int,%20double)))
  for the fitted size in both orientations, before the capture consent dialog. If none can, sharing does not
  start and the error says so. If the phone lists no hardware H.264 encoder, the existing "no H.264 encoder" check
  decides.
- **Desktop** applies the box with `applyConstraints` after capture starts, because Chromium reports the display
  size only then. If Chromium refuses, sharing fails with a message to pick a smaller size or frame rate.

## Requested versus actual

Both senders show three separate things:

1. **Requested**: the user's box and fps cap.
2. **Capturing**: the capture size applied to this screen (Android: after fitting to the display; desktop:
   what Chromium reports after `applyConstraints`).
3. **Sending**: measured `frameWidth`, `frameHeight` and `framesPerSecond` from WebRTC's `outbound-rtp` stats,
   plus `qualityLimitationReason`.

WebRTC may still send less than requested. Both senders use the `balanced` degradation preference, so under
CPU or bandwidth pressure the encoder lowers resolution and frame rate rather than freezing. The "Limited by"
value tells you why. Nothing here invents numbers: a field that a platform does not report is not shown.

## Idle screens (phone to desktop)

Screen capture only makes a frame when the screen changes, so a still screen used to send nothing, and the
first frame after a pause hit a cold link and lagged. The Android sender now repeats the last frame about
5 times a second while idle (`IdleRefresh.kt`). Repeats stay on the GPU via `SurfaceTextureHelper.forceFrame`
and get fresh timestamps so the encoder does not drop them. Real changes are never delayed.

- Phone Details: **Frame rate** is everything sent, including repeats. **Screen changes** counts only real
  changes and shows "Screen idle" at 0.
- Desktop viewer bar: **buffer** is the average time frames waited in the playback buffer each second.
  If lag after a pause remains and this number is high, the next step is a lower `jitterBufferTarget`.

## Remote control

Remote control maps pointer positions in 0 to 1 space onto the real display size (`DisplayGeometry.kt`), not
the encoded size. Because scaling keeps the aspect ratio, the desktop's `videoMatchesDisplay` check still
accepts the picture, and taps land on the same display pixel at any chosen size. Rotation re-fits the box and
updates the control geometry first, as before.

## Manual device checklist

Not yet run on real devices. Please check on an Android phone and a desktop:

1. Phone → desktop at the defaults (1920 × 1080, 60 fps). Details show Requested, Capturing and Sending.
2. Phone → desktop at 1280 × 720 at 30 fps, portrait then rotate to landscape. The picture keeps its shape;
   Capturing flips orientation; Sending stays at or below 30 fps.
3. Try 3840 × 2160 at 60 fps. Either it streams, or a clear encoder error appears before the consent dialog.
4. Type 720 as width and 1280 as height. The form refuses it.
5. With remote access on at 854 × 480, tap corners and a small button. Taps land where expected.
6. Desktop → phone at 1280 × 720 at 15 fps. The desktop bar shows the requested and captured size.
   Repeat on a portrait monitor if available.
7. Limit Wi-Fi bandwidth or pick a high size on a slow phone. Both sides stay usable and "Limited by" shows
   `bandwidth` or `cpu`.
