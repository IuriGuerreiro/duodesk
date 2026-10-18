# DuoDesk mobile

DuoDesk opens directly into the PC connection workspace. Create an invitation in the Windows receiver, scan its QR code or paste the full invitation, then start the bundled test video. The UI follows native sender events and displays the actual receiver address and stream statistics.

This branch sends the test clip only. It does not capture the phone screen or microphone. The sender stops when the app backgrounds, the screen loses focus, or the screen unmounts. `use-connection.ts` owns these rules and the unchanged `connect`, `start`, `stop`, and `subscribe` bridge calls. When merging Android screen capture, move its mode-aware `background`, `getStatus`, focus, and resume handling into this hook. Do not discard those changes when resolving the old `stream-test.tsx` route conflict. Keep `start` for the test clip and add `startScreen` only behind the native capability check.

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

## Styling

The app uses a light palette, system typography, 48–56 point button targets, safe areas, and a scrollable keyboard-aware layout. Tokens live in `tailwind.config.js`.

The installed versions are Expo 58.0.14, React Native 0.88.0, React 19.3.0, NativeWind 4.2.7, CSS Interop 0.2.7, and Tailwind CSS 3.4.19. Reanimated 4.7.1 and Worklets 0.13.0 retain Expo's versions. Tailwind Merge 2.6 handles Tailwind 3 classes. CSS Interop is a direct dependency because pnpm must resolve its generated JSX imports from this app.

[NativeWind's stable installation guide](https://www.nativewind.dev/docs/getting-started/installation) documents the v4 Babel/Metro integration and Reanimated 4 support. Its published peers accept this dependency graph; its documented release target is SDK 57, so native SDK 58 runtime validation remains necessary. NativeWind 5 is still an RC and was not adopted. Expo APIs were checked against the [SDK 58 documentation](https://docs.expo.dev/versions/v58.0.0/).

Button, Input, and Text are vendored from the [React Native Reusables NativeWind registry](https://github.com/founded-labs/react-native-reusables/tree/385834c2196f8a303cbc9057d1ac768f3bde0a3b/packages/registry/src/nativewind/components/ui), following its [manual installation](https://reactnativereusables.com/docs/installation/manual). They are adapted for DuoDesk tokens, larger touch targets, and React Native role types. Their MIT notice is in `src/components/ui/LICENSE`. Only the primitives used by these components are installed; no portal host is needed.

Add dependencies through `pnpm --filter @duodesk/mobile exec expo install <package>`. App icon, splash, or native dependency changes require a new development build.
