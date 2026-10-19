# DuoDesk mobile

DuoDesk opens directly into the PC connection workspace. Create an invitation in the Windows receiver, scan its QR code or paste the full invitation, then start the bundled test video. The UI follows native sender events and displays the actual receiver address and stream statistics.

The sender can stream the bundled test clip and, on Android development builds with native screen-sharing support, mirror the live display. It does not capture microphone audio. `src/features/stream-sender/use-sender-session.ts` owns the sender lifecycle, while `src/features/pairing/` owns QR scanning and manual invitation entry. Screen sharing remains gated by the native capability check.

## Watching the desktop screen

On Android, scanning a code made by the desktop's **Share this screen** tab opens `/watch`. `src/features/stream-viewer/` owns that screen. The native module answers the desktop's offer and draws the video in `StreamViewerView`, so frames stay out of JavaScript. `src/features/pairing/handoff.ts` passes the paired invitation to the screen without putting its token in a route. The same pairing flow serves both directions; the invitation's `direction` picks the sender or the viewer. iOS has no viewer yet and says so. The viewer is portrait only and untested on a physical phone; steps are in [desktop-to-phone screen sharing](../../docs/desktop-to-phone-screen-share.md).

## Development

Use Node 24 and pnpm 11 from the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm dev:mobile
pnpm --filter @duodesk/mobile lint
pnpm --filter @duodesk/mobile check-types
pnpm --filter @duodesk/mobile exec expo install --check
pnpm --filter @duodesk/mobile exec expo-doctor
pnpm --filter @duodesk/mobile build
```

`build` exports iOS, Android, and web JavaScript/assets. It does not compile a native app. The browser preview shows an unavailable-sender notice and disables native actions. Use a development build for camera and streaming checks. See [test-video setup](../../docs/test-video-validation.md) and the [root README](../../README.md) for native build prerequisites and signing.

Routes live in `src/app/`; `/stream-test` redirects to the main workspace for existing links. Pairing stays inline so opening the scanner or manual form does not blur the session screen.

For local address/code pairing and native integration points, see [device pairing](../../docs/device-pairing.md). Rebuild the development client after updating the native module.

## Styling

The app uses a light palette, system typography, 48–56 point button targets, safe areas, and a scrollable keyboard-aware layout. Tokens live in `tailwind.config.js`.

The installed versions are Expo 58.0.14, React Native 0.88.0, React 19.3.0, NativeWind 4.2.7, CSS Interop 0.2.7, and Tailwind CSS 3.4.19. Reanimated 4.7.1 and Worklets 0.13.0 retain Expo's versions. Tailwind Merge 2.6 handles Tailwind 3 classes. CSS Interop is a direct dependency because pnpm must resolve its generated JSX imports from this app.

[NativeWind's stable installation guide](https://www.nativewind.dev/docs/getting-started/installation) documents the v4 Babel/Metro integration and Reanimated 4 support. Its published peers accept this dependency graph; its documented release target is SDK 57, so native SDK 58 runtime validation remains necessary. NativeWind 5 is still an RC and was not adopted. Expo APIs were checked against the [SDK 58 documentation](https://docs.expo.dev/versions/v58.0.0/).

Button, Input, and Text are vendored from the [React Native Reusables NativeWind registry](https://github.com/founded-labs/react-native-reusables/tree/385834c2196f8a303cbc9057d1ac768f3bde0a3b/packages/registry/src/nativewind/components/ui), following its [manual installation](https://reactnativereusables.com/docs/installation/manual). They are adapted for DuoDesk tokens, larger touch targets, and React Native role types. Their MIT notice is in `src/shared/ui/LICENSE`. Only the primitives used by these components are installed; no portal host is needed.

Add dependencies through `pnpm --filter @duodesk/mobile exec expo install <package>`. App icon, splash, or native dependency changes require a new development build.
