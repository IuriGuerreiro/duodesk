# Android tap, swipe, scroll and typing from the desktop

While an Android phone shares its screen, the paired desktop can **tap** (a click), **swipe** (a click-drag), **scroll** (mouse wheel or trackpad, sent as a swipe) and, on Android 13+, **type** into the focused field (see [Typing](#typing)). Live raw keyboard, arrow keys and shortcuts, Back/Home/Recents, multi-touch, iOS control and unattended access are out of scope.

## Consent: three separate things

1. **The phone owner turns on the DuoDesk accessibility service** in Android Settings → Accessibility. DuoDesk cannot do this itself. On Android 13+ a sideloaded build may first need App info → ⋮ → _Allow restricted settings_. The service declares `canPerformGestures` and `flagInputMethodEditor` (typing, Android 13+). It listens to no events and has no `canRetrieveWindowContent`, so it cannot read the screen or the fields it types into.
2. **The owner taps "Remote access" in DuoDesk, for this session.** With accessibility enabled, this starts screen sharing and grants control after the stream connects. Otherwise it opens Accessibility settings and continues after the owner enables the service and returns. Returning without enabling it cancels the request. "Share screen" starts viewing only. Enabling the service outside this explicit flow grants no control. Every new share requires another Remote access press.
3. **The owner can stop at any time**: the "Stop remote access" button, the "Stop control" action in the sharing notification (which also says the PC can control the phone), turning the service off, stopping the share, or disconnecting.

DuoDesk does not try to get around the lock screen, secure (`FLAG_SECURE`) windows, or other protections. Android may ignore or cancel injected gestures there, and the desktop sees `cancelled` or `failed`.

## Wire protocol

Defined in `packages/protocol/src/control/`, mirrored in `ControlWire.kt`. Two data channels ride on the existing WebRTC connection, both **negotiated** (fixed ids, created by both ends before the offer, so neither waits for an announcement):

| Channel           | Id  | Direction  | Delivery                                                   | Carries                       |
| ----------------- | --- | ---------- | ---------------------------------------------------------- | ----------------------------- |
| `duodesk-control` | 1   | phone → PC | reliable, ordered                                          | `status`, `caps`, `result`    |
| `duodesk-input`   | 2   | PC → phone | ordered, packets expire after 500 ms (`maxPacketLifeTime`) | `tap`, `swipe`, `text`, `key` |

Commands travel on a short-lived channel so a network stall cannot replay old input later. Every message is JSON, at most 2048 bytes, version 1, carries the stream `sessionId`, and has exactly the documented fields. Anything else is dropped.

- `status`: `{epoch, state:"on", geometry:{width,height,rotation}}` or `{epoch, state:"off", reason}`. Sent on every change and repeated every second, so a channel that opens late learns the state. The desktop treats 4 s of silence as off.
- `tap`: `{epoch, seq, x, y}`. `swipe`: `{epoch, seq, durationMs 50–2000, points: 2–32 × [x, y]}`. Coordinates are 0–1 over the **whole captured display**.
- `caps`: `{epoch, text}`. Sent right after every status. `text` is true only while control is on, on Android 13+, with the input method available. The desktop keeps it only for the epoch it names and forgets it on any epoch change. A desktop that predates typing reads it as a malformed status and drops it; a phone that predates typing never sends it, so it never receives text.
- `text`: `{epoch, seq, text}`. 1–500 UTF-16 units, whole surrogate pairs only, no control characters except new line and tab. The desktop turns CRLF and CR into LF first. `key`: `{epoch, seq, key: backspace | delete | enter}`.
- `result`: `{epoch, seq, status: done | cancelled | failed}` or `rejected` with reason `stale | off | invalid | busy | nofield`.

The phone decodes input bytes as strict UTF-8 and drops anything malformed. The 2048-byte limit applies to the whole encoded message; 500 units always fit.

## Safety rules the phone enforces

- Input is accepted only while control is on and only when the command's `epoch` equals the current one. The epoch increases on Allow, stop, rotation or resize, and loss of the service, so a command made for an old screen shape or an old grant is refused, never remapped.
- `seq` must increase; replays are refused.
- **One gesture at a time, nothing queued.** A command that arrives while one is running is rejected `busy`. The desktop does the same and never queues.
- Gestures are single finished strokes (taps are 50 ms; swipes ≤ 2 s, ≤ 32 points). They are not split into held-down pieces, so a stop can never leave a finger stuck down. A gesture already handed to Android (2 s at most) cannot be recalled; nothing new starts after a stop.
- Control turns off, and stays off until allowed again, if the display size cannot be read.

## Typing

Android 13 (API 33) added an input method for accessibility services (`FLAG_INPUT_METHOD_EDITOR`, `AccessibilityService.getInputMethod`). It writes into the focused field through `InputMethod.AccessibilityInputConnection`. It cannot read the field. Older Android has no equivalent without reading the screen, so typing is not offered there.

- **Phone.** `ImeTypist` loads only on API 33+. A field counts as focused only when `getCurrentInputStarted()` is true and `getCurrentInputConnection()` is not null; otherwise the result is `rejected` / `nofield`. Text goes through `commitText(text, 1, null)`, which returns nothing, so `done` means "handed to the editor", not "shown". Backspace and Delete send `KEYCODE_DEL` / `KEYCODE_FORWARD_DEL` down and up, so the editor removes whole characters and never splits an emoji. Enter follows the field: with `IME_FLAG_NO_ENTER_ACTION` a multi-line field gets a new line and a single-line field gets an Enter key; otherwise a declared action (search, send, next…) runs through `performEditorAction`; otherwise multi-line fields get a new line and the rest an Enter key.
- **Same gates as gestures.** Allowed, current epoch, increasing `seq`, one command in flight (a gesture and a text share it). Typing finishes before the phone answers, so it never stays in flight.
- **Desktop.** "Type on phone" appears only while `caps.text` is true. Text is sent only on Send or Enter. Shift+Enter adds a line; Enter that confirms an IME composition does nothing. Send is disabled while any command is in flight. The draft stays until the phone answers `done`; edits made while sending are kept. If the answer never comes (timeout, revocation, disconnect), the composer says "Not confirmed. Check the phone before sending again." and never resends. Clicking the phone picture does not take focus from the composer. Escape in the composer only leaves it.
- **Privacy.** Text and keys are never logged, stored, or echoed in results. Results report only the outcome.
- **Limits.** Custom editors (games, terminals, some web canvases) may ignore input. Android may refuse password and lock screen fields. A service enabled by an older build may need to be turned off and on again before Android grants the input method flag.

## Coordinates and capture scope

- **Capture scope.** The screen-capture prompt is created with `MediaProjectionConfig.createConfigForDefaultDisplay()` on Android 14+, so the only choice is the whole screen. Before Android 14 the system always captures the whole screen. Single-app sharing is therefore not offered; control needs the full display.
- **The phone is authoritative for geometry.** `readDisplayGeometry` (real display size and rotation) feeds both the capture size and the `status` geometry, so the encoded frame and the touch space describe the same display. The desktop never infers display size from encoded dimensions; it only checks that the picture's aspect ratio matches the reported display (2% tolerance) and pauses input when it does not, for example while frames catch up after a rotation. It also waits 400 ms after any epoch change.
- **Desktop mapping.** The click layer sits exactly over the video's drawn picture (`object-fit: contain`), so black margins never receive clicks. The picture rectangle is re-measured on resize, fullscreen and video size change. Pointer positions are normalised against that rectangle at the moment of the click. A gesture that started under an older epoch is dropped.
- **Pixels.** `round(x × (width − 1))`, clamped to the display. Identical on both sides (`toPixel`, `RemoteControl.pixel`).
- **Clicks and drags.** Primary button only. Movement ≤ 8 px and ≤ 500 ms is a tap. A longer stationary press is ignored. Anything that moves is a swipe sent on release, simplified to ≤ 24 points. Escape, window blur or pointer cancel discards the gesture.
- **Wheel and trackpad.** There is no scroll command. The desktop sends an ordinary `swipe`, so the protocol and phone are unchanged. Details are in `wheel.ts`:
  - Pixel, line (16 px) and page deltas are converted to picture pixels. Wheel down moves the finger up, like a touch screen. Shift+wheel scrolls sideways when there is no horizontal delta. Ctrl+wheel (trackpad pinch, desktop zoom) is ignored and left to the desktop.
  - The swipe starts at the pointer and never moves, so it stays in the list under it. Travel is capped at 15% of the screen per swipe, and the end is clamped 3% from the edges. A pointer inside that 3% edge band sends nothing, to avoid system edge gestures. Duration is 200–400 ms, scaled by travel. These are tuning guesses, not measured defaults.
  - While the phone is busy, wheel movement collects up to one swipe's worth. The excess is lost, never queued. The collected scroll is sent when the current command completes, or dropped if the wheel has been still for over 250 ms. It is also dropped on epoch change, pause, shape mismatch, blur, Escape, the pointer leaving, a press starting, and teardown.
  - The wheel listener is native and non-passive, on the click layer only, so the desktop page does not scroll. Letterbox margins keep normal wheel behaviour. A wheel turn during a press is ignored.
  - Android's `dispatchGesture` cancels any gesture in progress, including the owner's own touch. That is one more reason one command stays in flight and nothing is queued.

## Code map

| Where                                                                       | What                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/protocol/src/control/`                                            | Messages, validators, mapping helpers                                     |
| `apps/mobile/modules/test-video/android/.../ControlWire.kt`                 | Strict parsing and message writers                                        |
| `.../RemoteControl.kt`                                                      | Per-session grant, epoch, gating (no Android types)                       |
| `.../ControlAccessibilityService.kt`, `res/xml/duodesk_control_service.xml` | Gesture and typing service and its declaration                            |
| `.../ImeTypist.kt`                                                          | API 33+ typing through the accessibility input method                     |
| `.../DisplayGeometry.kt`, `ScreenSource.kt`                                 | Display size and rotation                                                 |
| `.../VideoSender.kt`                                                        | Channels, heartbeat, teardown ordering                                    |
| `.../ScreenCaptureService.kt`                                               | Notification text and "Stop control" action                               |
| `apps/mobile/src/features/stream-sender/`                                   | Settings / Allow / Stop UI                                                |
| `apps/desktop/src/features/remote-control/`                                 | `ControlLink`, gesture recorder, click layer, status bar, typing composer |

The accessibility service is declared in the module's own manifest and resources, merged by Gradle like the existing capture service, so no config plugin is needed and `android/` stays generated.

## Verification record

| Check                                                                                                  | Result                             |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Protocol tests (validation, letterbox mapping, aspect check, pixel rounding)                           | pass                               |
| Desktop unit tests (link gating, epochs, pause, timeouts, recorder)                                    | pass                               |
| Desktop wheel tests (delta modes, direction, bounds, staleness, clearing, busy/completion/timeout)     | pass                               |
| Electron control layer: wheel default prevented on picture, not on letterbox or Ctrl+wheel             | pass                               |
| Samsung wheel scrolling (checklist below)                                                              | not yet tested on device           |
| Kotlin unit tests (wire format 6, grant / epoch / busy / replay / revoke / rotation / service loss 19) | pass                               |
| Electron loopback over real WebRTC: negotiated channels, status, tap, swipe, result, revoke            | pass                               |
| Existing video and audio loopbacks                                                                     | pass                               |
| arm64 Android debug APK builds                                                                         | pass                               |
| Samsung screen sharing with remote access enabled                                                      | owner confirmed; diagnostics below |
| Real-device rotation, fullscreen, audible playback and lock screen                                     | still need verification            |
| Typing: protocol, desktop link and composer helpers, Kotlin wire / gating / Enter choice               | pass                               |
| Typing: Electron loopback (caps, text, key, revoke) and composer overlay smoke                         | pass                               |
| Typing on a real phone (Samsung checks in the manual steps)                                            | not run                            |

### Wheel scrolling device checklist (Samsung, not yet run)

- [ ] Chrome page: wheel down/up scrolls down/up, with no stray taps.
- [ ] Settings list, and a nested list inside a scrolling page: the scroll stays in the list under the pointer.
- [ ] Horizontal carousel: Shift+wheel and a sideways trackpad swipe.
- [ ] Notched wheel vs. smooth trackpad: step size and fling feel. Tune `MAX_TRAVEL` and durations if needed.
- [ ] Fast wheel spin: no backlog after stopping, and a click right after scrolling still taps.
- [ ] Pointer near the screen edges: no notification shade, back gesture or app switcher.
- [ ] Rotation mid-scroll: nothing lands on the rotated screen.
- [ ] Owner touching the phone while the desktop scrolls: the owner's touch may be cancelled (Android behaviour).

Manual steps are in [manual-verification-android-screen-sharing.md](manual-verification-android-screen-sharing.md#remote-control).

### Desktop overlay regression check

Start Vite on port 1422 from `apps/desktop`, then run `pnpm test:control-surface` there. This renders the production control layer over moving video, enables control, and checks picture alignment, letterbox exclusion, resizing, and continued playback as native player controls disappear. The alignment check failed before the coordinate fix because viewport offsets were applied twice.

The phone owner previously reported a stream freeze when control starts. On 2026-10-23, after restarting the desktop and installing a build with lifecycle logging, the owner confirmed the session works. Desktop diagnostics observed a connected peer, playing 886 × 1920 video, audio packets, control heartbeats, eight outgoing gesture commands, and the active input layer beyond the toolbar's two-second hide timer. This successful run does not establish the cause of the earlier failure. Native logs now record state transitions, failures, and owner pause requests without gesture coordinates or pairing credentials.

### Integration with the main design

The desktop retains the design from main. The transparent input layer has no decorative outline, and its compact status and pause action sit in the existing floating toolbar. The toolbar stays above the input layer.

On the phone, Share screen is view-only. Remote access is the explicit per-session request to share and control the screen. A pending request survives the Accessibility settings round trip, then grants control after screen streaming starts. Cancellation, a denied capture request, or disconnection discards it. Stopping streaming keeps the pairing but ends control.

Integration checks passed: repository lint and typecheck, desktop build and UI smoke, video/audio/control loopbacks, the control layer against the production receiver UI, mobile flow tests, and Kotlin unit tests. The arm64 Android debug APK builds with `./gradlew :test-video:testDebugUnitTest :app:assembleDebug -PreactNativeArchitectures=arm64-v8a`. The later Samsung check is recorded above. The Accessibility settings round trip, rotation, lock screen, and audible playback still need device verification.
