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
  {
    // Unit tests run under plain node, so they import the receiver's internals directly.
    files: ["test/**"],
    rules: { "no-restricted-imports": "off" },
  },
];
