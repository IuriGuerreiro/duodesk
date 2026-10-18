import expoConfig from "eslint-config-expo/flat.js";
import { rules } from "@duodesk/eslint-config/rules";

export default [
  ...expoConfig,
  { ignores: ["dist/**", ".expo/**", "android/**", "ios/**"] },
  { rules },
];
