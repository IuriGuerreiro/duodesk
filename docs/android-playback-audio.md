# Android playback audio to desktop

Android screen sharing can also send **sound played by other apps** to the desktop receiver. It never records the microphone, and there is no microphone fallback. iOS and microphone audio are out of scope.

## How it works

1. JS asks for `RECORD_AUDIO` (Android requires it for any audio capture, including playback capture), then calls `startScreen(bitrate, shareAudio)`. Denied permission, Android 9 or older, or the switch being off all mean a video-only session. The sender reports why in `status.audio` / `status.audioMessage`.
2. The user approves the system screen-capture prompt. `ScreenCapturerAndroid` turns that result into the one `MediaProjection` (Android 14+ allows one per consent result). `ScreenSource.projection` exposes it.
3. `PlaybackAudioCapture` builds an `AudioRecord` from `AudioPlaybackCaptureConfiguration` on that same projection. It matches `USAGE_MEDIA`, `USAGE_GAME`, `USAGE_UNKNOWN` and excludes DuoDesk's own UID. The format is 48 kHz stereo PCM16.
4. PCM enters WebRTC through the audio device module (see below) and is encoded as Opus on the same peer connection and in the same `duodesk` stream as the video. One stream plus one RTCP CNAME is what lets the browser keep lip sync.
5. The desktop adds a receive-only audio transceiver, aggregates every incoming track into one `MediaStream`, asks for stereo Opus in its answer (`stereo=1`), and offers mute, volume and an autoplay fallback.

## WebRTC library finding

The previous dependency, `org.jitsi:webrtc:155.0.0`, cannot take external PCM. Its Java audio path is `JavaAudioDeviceModule` → `WebRtcAudioRecord`, which only creates a microphone `AudioRecord` internally (package-private, no `AudioPlaybackCaptureConfiguration` hook). `SamplesReadyCallback` only observes. `AudioFrameProcessor` and `AudioProcessingFactory` take native pointers, so using them needs a C++ build against WebRTC headers that the AAR does not ship.

The module now uses `io.github.webrtc-sdk:android:150.7871.01` (LiveKit's BSD-3 build of the same `org.webrtc` API). It adds:

- `JavaAudioDeviceModule.Builder.setAudioBufferCallback(...)`: the audio thread hands over each 10 ms buffer to fill in place and takes back a capture timestamp.
- `JavaAudioDeviceModule.setAudioRecordEnabled(false)`: "recordingless" mode, so **no microphone `AudioRecord` is ever created**.

In that mode the audio thread does not pace itself, so the callback must block. `PlaybackAudioCapture.readInto` blocks on the playback `AudioRecord`. `SilencePacer` supplies real-time silence while capture is not running (before the projection is ready, or after a capture failure). Capture times come from `AudioRecord.getTimestamp` on the monotonic clock, the same clock the video capturer uses. Echo cancellation, noise suppression and auto gain are switched off for the audio source, because they would damage already-final app audio.

Video code compiled unchanged against the new library. iOS still uses JitsiWebRTC; this change does not touch it.

## Lifecycle and ownership

- `ScreenCaptureService` (foreground service, type `mediaProjection`) still owns the notification. The projection belongs to `ScreenCapturerAndroid`; audio only borrows it and never stops it.
- `VideoSender.close()` stops audio first (this unblocks a pending read and releases the `AudioRecord` under a lock), then stops the screen capturer, then closes the peer. It runs on stop, reconnect, desktop stop, projection revocation (`MediaProjection.Callback.onStop`) and service destruction.
- A read error after negotiation stops audio, sets `audio: "failed"` and keeps the video running. The audio m-line stays in the SDP, so the desktop hears silence and the phone shows why.

## What cannot be captured (be honest in the UI)

Per the [Android docs](https://developer.android.com/media/platform/av-capture): usages other than media, game and unknown (for example calls and some assistants), apps that set `allowAudioPlaybackCapture="false"` or use a capture policy of system/none, apps targeting Android 9 or older without opting in, and other user profiles stay silent. DuoDesk does not work around these. The mic permission prompt is required by Android, not used for recording.

## Verification record

| Check                                                                                            | Result                                             |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Unit tests (Kotlin): audio gating, timestamp math, silence pacing, consent                       | 13 pass                                            |
| Desktop tests, `tsc`, ESLint, Prettier, production build                                         | pass                                               |
| Electron loopback: Opus + H.264 in one stream, stereo preserved (left tone only: L 0.71, R 0.00) | pass                                               |
| Electron UI smoke, native host integration tests                                                 | pass                                               |
| Android debug APK builds and installs (Samsung SM-A266B, Android 16)                             | pass                                               |
| Real-device sound, A/V sync, reconnect, capture-stop                                             | **not run**: phone was behind a secure lock screen |

Manual steps for the real-device checks are in [manual-verification-android-screen-sharing.md](manual-verification-android-screen-sharing.md#audio).
