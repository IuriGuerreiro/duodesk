# DuoDesk design direction

**Premium mono, one blue.** The UI uses near-black surfaces, white type and grey for anything secondary. Blue is used only for "live" and the main action, so the look stays calm, quiet and easy to follow.

Source of truth: `packages/design-tokens` (`index.ts` for mobile, `tokens.css` for desktop). Keep both files in sync.

## Rules

1. **Blue is rare.** Use it only for the main action and "live", never as decoration.
2. **One task per screen.** Hide anything that isn't needed right now.
3. **Plain words.** Write "Reconnecting…", not "ICE state: disconnected".
4. **No gradients, no glow.** Depth comes from stepping up the surface shades and from 1px borders.
5. **Short motion.** Fades last 150–250ms. Nothing bounces.
6. **Dark mode only** for v1.

## Colors

Each color has one job.

| Token | Hex | Use |
| --- | --- | --- |
| background | `#0A0A0B` | App canvas |
| surface1 | `#111113` | Cards, panels |
| surface2 | `#18181B` | Inputs, sheets |
| surface3 | `#232327` | Hover, secondary button |
| border | `#2A2A2F` | 1px dividers |
| borderStrong | `#3A3A40` | Input borders |
| text | `#FAFAFA` | Headings, body |
| text2 | `#A1A1AA` | Descriptions |
| text3 | `#71717A` | Hints, labels |
| blue | `#3B82F6` | Primary action, live |
| blueHover | `#2563EB` | Pressed / hover |
| blueSoft | `#3B82F6` at 14% | Live pill, selection |
| success | `#22C55E` | Step done |
| warning | `#F59E0B` | Reconnecting |
| danger | `#EF4444` | Stop, errors |

## Type

- **UI font:** Geist, falling back to Inter and then the system font.
- **Mono:** Geist Mono, for pairing codes and numbers.

| Style | Size / weight | Letter spacing |
| --- | --- | --- |
| Display | 32 / 600 | -0.9 |
| Title | 22 / 600 | -0.4 |
| Body | 15 / 400 | 0 |
| Small | 13 / 400 | 0 |
| Code | 20 / 600 mono | 0 |

## Spacing, radius, motion

- **Spacing:** 4, 8, 12, 16, 24, 32.
- **Radius:** 10 for controls, 14 for cards, 999 for pills.
- **Motion:** 150ms (fast) and 220ms (base).

## Components

- **Primary button:** blue fill, white text, 40px tall. The one main action per screen.
- **Secondary button:** surface3 fill with a strong border.
- **Ghost button:** no fill, text2 color. For minor actions like "Disconnect".
- **Danger button:** danger-colored text with a faint red border. For "Stop streaming".
- **Status pill:** 28px tall and rounded, with a dot.
  - Live: blueSoft background and a pulsing blue dot.
  - Reconnecting: amber.
  - Waiting: grey.
- **Pairing code:** 6 mono digit boxes on surface2 with a strong border.
- **Card:** surface1 background, 1px border, radius 14.

## The flow

Desktop and phone move through the same states together.

1. **Pair.** Desktop shows a QR code and a code card. The phone opens the camera straight away, with paste as a fallback.
2. **Connecting.** Found, then Securing, then Starting. Shows the PC name.
3. **Live.**
   - Desktop: the video fills the window and the floating bar hides itself.
   - Phone: a live dot, with **Stop streaming** (danger) and **Disconnect** (ghost).
4. **Stop streaming.** The video ends but the connection stays, so the phone goes back to "Connected" and the desktop to "Waiting for video".
5. **Reconnecting.** An amber pill and automatic retries. Pair again only if the retries fail.

## Platform notes

**Desktop (Electron + React)**
- Uses the CSS variables `--dd-*` from `tokens.css`.
- The manual invitation box has a fixed height so it never grows past the window.

**Mobile (Expo)**
- Imports `colors`, `type` and `space` from `@duodesk/design-tokens`.
- A single stack of screens: Home → Scan or Paste → Live. There are no tabs.
- Mobile uses the shared dark palette for its NativeWind theme, screen surfaces, inputs, buttons, status bar, and native splash screen. Stream options and live statistics are collapsed by default. Share screen and Remote access remain separate session actions.
- While sharing, a "DuoDesk is sharing your screen" notification stays visible.

## Open issues

- The "Securing the link" spinner on mobile is hard to see.
- Phase 5 (remember the last PC, one-tap reconnect, motion pass) is not done yet.
