import expoConfig from "eslint-config-expo/flat.js";
import { rules } from "@duodesk/eslint-config/rules";

export default [
  ...expoConfig,
  { ignores: ["dist/**", ".expo/**", "android/**", "ios/**"] },
  { rules },
  {
    // Unit tests run under plain node, so they import feature internals directly.
    files: ["test/**"],
    rules: { "no-restricted-imports": "off" },
  },
];
