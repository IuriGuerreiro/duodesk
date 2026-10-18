# @duodesk/eslint-config

Desktop React and protocol packages use the TypeScript-aware `base` and `react-internal` flat configs. The Expo app uses its SDK-matched config and imports `rules` for shared framework-independent checks. Lint errors fail the task; no warning-only plugin is installed.

The shared `rules` also forbid deep imports into a feature (`@/features/<name>/<file>`). Features expose a public `index.ts` and other code imports `@/features/<name>`. Desktop unit tests run under plain node and are exempt.

The official Expo starter's web hydration hook has one file-specific `react-hooks/set-state-in-effect` exception to retain its mount-time hydration guard. All other Expo rules remain enabled.
