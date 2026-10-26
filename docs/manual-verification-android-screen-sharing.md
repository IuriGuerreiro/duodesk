# How to manually verify Android live screen sharing

This guide provides procedures to verify Android live screen sharing against a local DuoDesk desktop receiver.

## Prerequisites

1. Set up the development tools.
   - Install JDK 21. Set `JAVA_HOME=/home/rshazow/.local/opt/jdk-21`.
   - Install Android SDK with build tools 36 or 37. Set `ANDROID_HOME=/home/rshazow/Android/Sdk`.
   - Connect an Android device with USB debugging enabled. The device must run Android 7.0 (API 24) or later. Android 14 (API 34) or later is recommended to verify content resize callbacks.

2. Verify device connection over adb.
   ```sh
   adb devices -l
   ```
   Confirm that your device appears in the device list.

## Step 1: Build and start the desktop receiver

1. Build the desktop signaling host and receiver application.

   ```sh
   pnpm --filter @duodesk/desktop build
   ```

2. Start the desktop receiver.
   On Linux or macOS with Electron:

   ```sh
   pnpm --filter @duodesk/desktop dev
   ```

   On Windows with Tauri:

   ```sh
   pnpm dev:desktop:tauri
   ```

3. Select your local Wi-Fi or Ethernet IPv4 address in the network dropdown.
4. Click **Create connection**.
5. Copy the generated JSON text from the manual invitation box or keep the QR code visible.

## Step 2: Install and launch the mobile application

1. Build and install the Android debug development build.

   ```sh
   ./scripts/verify-android-screen-sharing.sh
   ```

   Alternatively, install the APK manually:

   ```sh
   adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
   ```

2. Start the Metro bundler if you are running in development mode.

   ```sh
   pnpm --filter @duodesk/mobile start
   ```

3. Open the DuoDesk application on your phone.
4. Navigate to the **Stream test** tab.
5. Confirm that the UI displays the **Share screen** button alongside the **Start test clip** button.

## Step 3: Connect to the desktop receiver

1. Paste the invitation JSON into the input field or scan the QR code.
2. Tap **Connect**.
3. Verify that the status text changes from `idle` to `connecting`, then to `ready`.
4. Verify that the desktop receiver displays the connected device session.

## Step 4: Verify screen sharing start and foreground notification

1. Select a bitrate between 2 and 30 Mbps.
2. Tap **Share screen**.
3. On Android 13 or newer, allow the system notification permission prompt when prompted.
4. Observe the system screen casting permission prompt: "DuoDesk will start capturing everything that's displayed on your screen".
5. Tap **Start now**.
6. Observe the persistent notification in the Android notification drawer:
   - Notification title: "DuoDesk".
   - Notification text: "Sharing screen with Windows receiver".
   - Visible "Stop" action button.
7. Verify that live frames from your phone screen display in the desktop receiver.
8. Verify that the mobile status text shows `Status: streaming (screen)`.

## Step 5: Verify survival across other applications

1. Press the Android **Home** button to background DuoDesk.
2. Open another application, such as the Settings app or Chrome.
3. Observe the desktop receiver.
4. Confirm that the desktop receiver continues streaming your active screen without freezing or disconnecting.
5. Contrast this with test clip mode, which terminates immediately upon backgrounding.

## Step 6: Verify rotation and dynamic display resizing

1. Enable auto-rotate on the Android device.
2. Rotate the device from portrait to landscape orientation.
3. Observe the desktop receiver.
4. Confirm that the video aspect ratio updates to match landscape orientation.
5. Confirm that no second SDP offer or renegotiation dialog occurs.
6. Rotate the device back to portrait orientation.
7. Confirm that the video aspect ratio returns to portrait.

## Step 7: Verify stop and teardown scenarios

Test each stop scenario independently with a fresh desktop invitation.

### Scenario A: Stop from the Android notification

1. Pull down the Android notification shade while screen sharing is active.
2. Tap the **Stop** button on the DuoDesk notification.
3. Confirm that the notification dismisses immediately.
4. Confirm that the desktop receiver video stops and displays the session ended state.
5. Confirm that the mobile app status transitions to `stopped`.

### Scenario B: Stop from the mobile application

1. Return to the DuoDesk **Stream test** screen during active sharing.
2. Tap **Stop / disconnect**.
3. Confirm that the notification dismisses.
4. Confirm that both mobile and desktop report session stopped.

### Scenario C: Stop from the desktop receiver

1. Click **Stop session** on the desktop receiver.
2. Confirm that the mobile capture stops and the persistent notification dismisses.
3. Confirm that the mobile status transitions to `stopped`.

### Scenario D: User denial of screen capture consent

1. Connect a fresh session until status reaches `ready`.
2. Tap **Share screen**.
3. Tap **Cancel** on the system MediaProjection permission dialog.
4. Confirm that the app rejects the action with `Screen capture permission was denied`.
5. Confirm that the session returns to `ready` or fails cleanly without crashing.

## Step 8: Log inspection

To monitor native WebRTC and capture logs during testing, run:

```sh
adb logcat -v time -s DuoDesk ScreenCaptureService ScreenSource WebRTC:D AndroidRuntime:E
```

Look for these key milestones in the log:

- `ScreenCaptureService` onCreate and startForeground with type `mediaProjection`.
- `ScreenSource` computeCaptureDimensions and initialize.
- `changeCaptureFormat` on display rotation.
- Clean shutdown on `ACTION_STOP` or session close.

## Audio

Needs Android 10+ and an app that allows capture (YouTube and Spotify do; phone calls do not). Details: [android-playback-audio.md](android-playback-audio.md).

1. Connect and keep **Share phone audio** on. Tap **Share screen**. Allow the microphone prompt (Android requires it for playback capture), then the screen-capture prompt.
2. Confirm the badge reads `VIDEO + AUDIO` and stats show `Audio … kbps`. Confirm the microphone indicator is not shown for DuoDesk's own audio use.
3. Play a video or music in another app, with DuoDesk in the background. On the desktop, confirm sound plays, the mute button and volume slider work, and mouth movement matches speech.
4. Play a clip with a left-only tone and confirm it only plays on the left (stereo).
5. Deny the microphone prompt, or turn the switch off. Confirm video still streams, the badge reads `NO AUDIO`, and the phone explains why. Microphone audio is never used instead.
6. Stop from the notification, the app and the desktop. After each, confirm no capture indicator remains and `adb shell dumpsys media.audio_flinger | grep -i record` shows no DuoDesk record.
7. Reconnect with a new pairing code and repeat step 3. Revoke the projection from the status bar chip or quick settings mid-stream and confirm everything stops.

## Remote control

Design and safety rules: [android-remote-control.md](android-remote-control.md). Start a screen share with the desktop receiver, then:

1. **Service off.** Start Share screen. The phone offers "Remote access", and the desktop toolbar shows "View only". Clicking the video does nothing. Tap Remote access and confirm that Accessibility settings open.
2. **Service on, not allowed.** Turn on DuoDesk in Settings → Accessibility (on Android 13+ allow restricted settings first). The phone offers "Remote access". The desktop stays in view-only mode.
3. **Remote access.** Tap "Remote access". With accessibility off, enable DuoDesk in the opened settings and return. Sharing and control start automatically. With accessibility already enabled, control starts without a second Allow action. The desktop floating toolbar shows "Remote access" and the video has no decorative control outline. The notification reads "Your PC can tap, swipe and type on this phone" with a "Stop control" action.
4. **Tap and swipe.** Click an app icon on the desktop: it opens. Click-drag up or down on a list: it scrolls. A drag that leaves the picture still ends at its edge. Right-click and a long press without moving do nothing.
5. **Letterbox.** Resize the window so black bars show. Clicks on the bars do nothing; clicks at the picture's corners hit the phone's corners. Repeat in fullscreen.
6. **Rotation.** Rotate the phone with an auto-rotating app open. The desktop briefly says "syncing", then clicks land correctly in the new orientation.
7. **Stop paths.** Each must stop input at once, and the desktop must say control is off: "Stop remote access" in the app; "Stop control" in the notification; turn the accessibility service off; stop sharing; disconnect from the desktop. After each, a new session starts with control **off**.
8. **Pause.** "Pause" on the desktop stops sending; the phone stays allowed.
9. **Protected screens.** Open the lock screen or a payment screen. Gestures may be ignored; the desktop must not report success when Android cancelled them.
10. **Media.** Throughout, video keeps flowing, and with audio on, sound continues.

### Typing (Android 13+, not yet run on a device)

Use the Samsung phone. None of these checks has been run yet; record results here.

1. **Flag update.** Install the build over one whose service was already on. If "Keyboard on" never appears on the desktop, turn the DuoDesk accessibility service off and on again, then confirm it appears. The Accessibility description mentions typing.
2. **Fields.** Tap a text field on the phone through the desktop, type on the desktop keyboard: each key appears as it is typed. Type fast and confirm nothing is lost or reordered. Try a search box, a chat box, a URL bar, and a multi-line note. Text inserts at the cursor and replaces a selection.
3. **Unicode.** Emoji with skin tones and family sequences, accented letters, Arabic or Hebrew (right-to-left), Japanese from a desktop IME. Enter while composing in the desktop IME must not reach the phone; only the finished characters do. Backspace removes a whole emoji.
4. **Keys.** Backspace, Delete, Enter and Tab. Ctrl+C and other shortcuts must not reach the phone; Esc turns the keyboard off. Enter runs the field's action in search and chat fields (search, send, next) and adds a line in multi-line notes.
5. **No field.** With no field focused, typing says "Tap a text field on the phone first" and nothing waits to be sent.
6. **Password and lock screen.** A password field and the lock screen PIN. Android may refuse; the desktop must not claim success when nothing was handed to an editor. Some custom editors (games, terminals, web canvases) may ignore input even when the desktop says "Sent".
7. **Long paste.** Paste more than 500 characters: the desktop says it is too long and nothing is sent. Paste text with Windows line endings: lines arrive as single new lines.
8. **Revocation and disconnect.** Stop control or disconnect while a send is in flight: the desktop says a key was not confirmed, drops waiting keys, and never resends.
9. **Older Android.** On Android 12 or older, the phone keyboard never appears and taps and swipes still work.

Also verify that Remote access from the connected, non-streaming state survives the Accessibility settings round trip without re-pairing. Return without enabling the service and confirm that no share or control starts. Stop streaming, start Share screen, and confirm control stays off.
