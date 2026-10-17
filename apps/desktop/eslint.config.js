import { config } from "@duodesk/eslint-config/react-internal";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    ignores: [
      "dist/**",
      "build/**",
      "release/**",
      "bin/**",
      "src-tauri/**",
      "node_modules/**",
    ],
  },
];
