import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import { rules } from "./rules.js";

/** @type {import("eslint").Linter.Config[]} */
export const config = [
  { ignores: ["**/dist/**", "**/build/**", "**/.turbo/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: { globals: globals.node },
    rules,
  },
];
