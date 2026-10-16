import expoConfig from "eslint-config-expo/flat.js";
import { rules } from "@duodesk/eslint-config/rules";

export default [
  ...expoConfig,
  { ignores: ["dist/**", ".expo/**", "android/**", "ios/**"] },
  { rules },
  {
    // Official starter hydration guard intentionally switches state after mounting.
    files: ["src/hooks/use-color-scheme.web.ts"],
    rules: { "react-hooks/set-state-in-effect": "off" },
  },
];
