# Android screen streaming

Android now sends live screen frames through the existing native H.264 WebRTC sender. The bundled clip remains a diagnostic option. iOS still sends the clip. No audio or remote control is implemented. The Windows Tauri receiver and invitation/signaling format are unchanged.

## Build and run

Use Node 24+, pnpm, JDK 21, and an Android SDK with platform 37 installed. From the repository root:

```sh
pnpm install --frozen-lockfile
export JAVA_HOME=/home/rshazow/.local/opt/jdk-21
export ANDROID_HOME=/home/rshazow/Android/Sdk
pnpm --filter @duodesk/mobile exec expo prebuild --platform android --no-install
cd apps/mobile/android
./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
```

The APK is `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`. Install it on an ARM64 device and start `pnpm dev:mobile` from the repository root. Expo Go cannot load this native module. EAS development and preview builds also include the module.

`apps/mobile/android` is generated and ignored. The local Expo module's versioned Android manifest supplies the foreground-service permissions and service through manifest merging; no generated native files need editing.

## Use

1. Run the Windows Tauri receiver and create an invitation on a reachable LAN address.
2. In Stream test, scan or paste the invitation, then Connect.
3. Select Live screen and tap Share screen. Approve Android's consent dialog. On Android 14+, choose an app or the whole display.
4. Switch apps. Sharing continues while DuoDesk's foreground service runs. Return to DuoDesk to inspect sender dimensions, frame rate, bitrate, and codec.
5. Stop from DuoDesk, the sharing notification, Android's sharing controls, or Windows. A new session needs a new Windows invitation and fresh Android consent.

Cancelling consent leaves the paired sender ready for another attempt. Stop/disconnect during consent invalidates the pending request; a late approval cannot start capture. Finish an outstanding system dialog before requesting another capture. The diagnostic clip and iOS sender stop on backgrounding. Leaving the Stream test route ends either source.

Screen sharing ends on screen lock, projection revocation, task removal, module destruction, negotiation timeout, or connection loss. There is no automatic restart after process death. Android may terminate the process; a foreground service does not guarantee indefinite execution. Protected content can appear black. If notification permission is denied on Android 13+, Android may show the foreground service only in its active-apps UI; its projection controls and DuoDesk's Stop remain available.

## Native implementation

- `TestVideoModule.kt` requests system consent and consumes the activity result. Consent data stays native and is never cached for another session.
- `VideoSender.kt` owns the existing serial session queue, service binding, and WebRTC negotiation. Its generation check rejects callbacks from stopped sessions.
- `ScreenCaptureService.kt` promotes to `mediaProjection` foreground service before obtaining the projection. It supplies an ongoing notification with Stop and latches stop requests that arrive before capture setup.
- `ScreenSource.kt` feeds GPU textures into the existing `VideoSource` without copying frames through JavaScript. It registers the projection callback before creating one virtual display. Android 14+ content-size callbacks resize that display and its texture; older Android uses display changes. Output preserves aspect ratio, uses even dimensions, and caps the long edge at 1920 pixels and delivery at 30 fps. Actual encoding depends on the device and network.

Cleanup releases projection callbacks, virtual display, surface, texture helper, video track/source, peer connection, timers, socket, and service binding. Normal resizing does not create a second display or renegotiate the peer connection.

## Integration with pairing work

The source selector and Android background behavior are in `apps/mobile/src/app/stream-test.tsx`. Keep those changes when integrating another pairing UI. The native bridge adds `startScreen(bitrateMbps)` on Android. The TypeScript `start(bitrate, source)` defaults to the existing clip API for compatibility. Android UI explicitly chooses `screen`; iOS keeps `clip`.

Do not restore unconditional JavaScript Stop on Android AppState background events: it would stop capture when switching to the app being shared. Android native code keeps only consent-pending/screen sessions alive; clip sessions still stop. Route cleanup still calls Stop. Pairing, certificate pinning, signaling fields, and Windows receiver code remain untouched. Any future invitation-format change must update the existing native Android and iOS parsers alongside the shared protocol.

## Checks completed in this workspace

- Frozen pnpm install and Expo 58 Android prebuild passed.
- Mobile lint and TypeScript checks passed. On a fresh checkout, start Expo once to generate the ignored `expo-env.d.ts` before type checking.
- `:test-video:compileDebugKotlin` and full ARM64 `:app:assembleDebug` passed with JDK 21.
- APK manifest inspection confirms the non-exported `mediaProjection` service and both foreground-service permissions. The diagnostic MP4 and ARM64 WebRTC library are packaged.
- Existing protocol tests passed, 2 tests. Existing desktop receiver tests passed, 3 tests.
- Lifecycle review found and corrected an early service Stop/start race. The follow-up review had no remaining required findings.

These are build/static checks and existing signaling tests, not an end-to-end screen capture test. No native iOS build or physical-device test was run here.

## Device validation still required

No device is attached to this workspace. The earlier bundled-clip result was reported by the user; it is not a live-capture result. Check these on physical Android devices, including Android 14+ and an older supported version:

- Deny/cancel consent, retry while paired, and stop while the dialog is open. Late approval must not capture.
- Share the full display and a single app; switch apps, rotate repeatedly, resize/multi-window, and verify Windows aspect ratio and sender dimensions.
- Stop via app, notification, system projection control, and Windows. Lock the screen, remove the app task, kill/relaunch the process, and disconnect Wi-Fi. Verify capture/notification end and fresh consent is required.
- Repeat connect/share/stop and rapid stop during service startup or SDP negotiation. Check for stale notifications, crashes, and growing native memory.
- Deny notification permission, check Android's sharing control still stops capture, and check protected content behavior.
- Run the diagnostic clip in foreground/background. Recheck the unchanged iOS clip flow on an iPhone/iPad.

## Documentation consulted

Implementation follows [Expo SDK 58](https://docs.expo.dev/versions/v58.0.0/), [Expo Modules activity events](https://docs.expo.dev/modules/module-api/), [Expo native generation](https://docs.expo.dev/workflow/continuous-native-generation/), [Android MediaProjection](https://developer.android.com/media/grow/media-projection), and [mediaProjection foreground-service requirements](https://developer.android.com/develop/background-work/services/fgs/service-types#media-projection). In particular, Android 14+ requires fresh consent per capture session and permits only one virtual-display creation per projection.
