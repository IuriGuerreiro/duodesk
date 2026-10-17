# DuoDesk

Electron and retained Tauri desktop hosts share a React/TypeScript/Vite receiver alongside the Expo mobile app in a pnpm + Turbo workspace. See [desktop setup, packaging, and validation](apps/desktop/README.md). Both apps import `@duodesk/protocol`. The first test-video sender and Windows receiver are implemented, with native-device validation pending. See [test-video setup and validation](docs/test-video-validation.md). iPad screen broadcasting follows after this experiment. See [architecture](docs/architecture.md) and the [approved scaffold plan](docs/scaffold-plan.md).

## Tooling and commands

Use Node **24.14.0**, pinned in `.node-version`, and **pnpm 11.18.0**, pinned in `package.json`. Install that pnpm version with `npm install --global pnpm@11.18.0`. Run workspace commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm check-types
pnpm build
pnpm dev
```

`pnpm build` builds the desktop UI and native Rust signaling sidecar, and exports production Expo bundles for iOS, Android, and web into each app's `dist/`. Desktop installers and native mobile apps are separate commands. Turbo caches frontend checks and mobile exports; desktop builds bypass caching because the sidecar is specific to the host OS and architecture.

```sh
pnpm dev:web                     # marketing landing page, localhost:5174
pnpm dev:desktop                 # Electron + bundled UI + Rust signaling
pnpm dev:desktop:tauri           # retained Tauri app + Vite
pnpm build:desktop               # desktop UI + native signaling sidecar
pnpm package:desktop             # native Electron package for the current OS
pnpm dev:mobile                  # Metro for the development client
pnpm --filter @duodesk/desktop tauri build
pnpm --filter @duodesk/mobile exec expo-doctor
pnpm --filter @duodesk/mobile exec expo install --check
```

Electron needs Rust and native C/C++ build tools for signaling, plus the OS runtime libraries listed in the [desktop guide](apps/desktop/README.md). Tauri remains available with its [own prerequisites](https://v2.tauri.app/start/prerequisites/), including WebView2 on Windows. Run the native commands on the target OS. Local iOS compilation needs macOS and Xcode; Android needs its SDK/JDK toolchain. Native mobile builds remain explicit `pnpm --filter @duodesk/mobile exec expo run:ios --device` or `expo run:android --device` commands. Generated native folders stay ignored.

Use `pnpm --filter @duodesk/mobile exec expo install <package>` to add mobile dependencies. Keep Expo's SDK-matched React and React Native versions. The shared TypeScript base supplies strict checks; Expo's base and the desktop's Vite settings retain their platform-specific resolution and JSX behavior. Expo uses its own ESLint config plus the shared framework-independent rules. Desktop and protocol use the shared TypeScript ESLint config. TypeScript 6.0.3 stays within the parser's supported range.

## Android development

The same streaming screen supports Android and iOS. For Android, connect a phone with USB debugging enabled and run `pnpm --filter @duodesk/mobile android` with JDK 21 and the Android SDK installed. For an installable EAS APK, run `pnpm dlx eas-cli@25.1.1 build --platform android --profile development` from `apps/mobile`. Start `pnpm dev:mobile` to serve the development client. See [test-video setup](docs/test-video-validation.md) for pairing and validation.

## Physical iPad development

These are manual setup steps, not actions performed by the scaffold. An Expo account and a paid Apple Developer membership are needed for EAS-signed physical iPad builds. Choose a bundle identifier you control in `apps/mobile/app.json` before configuring signing. The mobile config links to the existing `@rshazow/duodesk` EAS project. Signing credentials are managed separately.

From `apps/mobile`, when ready to submit an iOS cloud build:

```sh
npx eas-cli@latest login
npx eas-cli@latest build:configure
npx eas-cli@latest device:create
npx eas-cli@latest build --platform ios --profile development
```

Open the device-registration link on the physical iPad and follow the profile steps to register its UDID before building. Let EAS manage the Apple signing certificate and ad hoc provisioning profile, or supply your own. Include the registered iPad when prompted. The `development` profile enables the development client and internal distribution with `ios.simulator: false`. The separate `development-simulator` profile is for the simulator only.

Open the completed EAS build's installation link/QR on the registered iPad and install it. Enable Developer Mode if prompted. Start `pnpm dev:mobile` from the repository root, connect the iPad and host to the same reachable LAN, then open the Metro QR/link in the installed DuoDesk development client. Allow local network access and host firewall access to Metro. Guest Wi-Fi isolation can block the connection. Rebuild the native client after native dependency or native config changes; ordinary JS changes use Metro.

See Expo's [development build setup](https://docs.expo.dev/develop/development-builds/introduction/?buildenv=build-with-eas), [internal distribution and device registration](https://docs.expo.dev/build/internal-distribution/), and [using a development build](https://docs.expo.dev/develop/development-builds/use-development-builds/).

## Starter provenance

The local pnpm generator cache contains `create-turbo@2.11.8`, `create-tauri-app@4.7.5`, and `create-expo-app@5.0.0` from scaffold creation. Their published package metadata is verifiable with:

```sh
pnpm view create-turbo@2.11.8 version dist.tarball
pnpm view create-tauri-app@4.7.5 version dist.tarball
pnpm view create-expo-app@5.0.0 version dist.tarball
```

Equivalent official generator commands, run in a disposable directory rather than over this checkout:

```sh
pnpm dlx create-turbo@2.11.8 turbo-root --package-manager pnpm
pnpm dlx create-tauri-app@4.7.5 tauri-desktop --template react-ts --manager pnpm
pnpm dlx create-expo-app@5.0.0 expo-mobile --template default --no-install
```

These reconstruct the generator selections, not a captured shell transcript. The original Expo template tarball version was not recorded, and `default` can change independently of the generator version. The committed baseline and lockfile preserve the actual source and dependency graph. The imported Expo starter uses SDK 58, Router, React 19.3 and React Native 0.88. The Turbo examples were removed; app identities, workspace imports, development client, and shared tooling were integrated. Starter screens remain intact.

Official references: [Turbo installation](https://turborepo.dev/docs/getting-started/installation), [Tauri creation](https://v2.tauri.app/start/create-project/), [create-expo-app](https://docs.expo.dev/more/create-expo/), [Expo monorepos](https://docs.expo.dev/guides/monorepos/), [SDK 58](https://docs.expo.dev/versions/v58.0.0/).

## Validation boundaries

See the [local validation record](docs/scaffold-validation.md) for commands, results, and review coverage.

CI runs frozen installation, lint, typechecking, desktop UI and Rust sidecar build, and Expo production exports. It checks that iOS/Android bundles and the web entry exist. JS exports validate bundling and workspace resolution, not native compilation, signing, installation, capture, or device behavior.

Android sender compilation, JavaScript checks, production exports, and local signaling checks pass. Windows playback and physical Android/iPad streaming still need device validation. No cloud build has been submitted for this change.

DuoDesk original code uses [PolyForm Noncommercial](LICENSE.md). See [NOTICE](NOTICE) for third-party licensing; the Expo starter retains its own license notice.

For desktop address selection and six-digit local pairing, see [device pairing](docs/device-pairing.md).
