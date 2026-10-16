import { config } from "@duodesk/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    ignores: ["dist/**", "build/**", "node_modules/**"],
  },
];
