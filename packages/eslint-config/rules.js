/** Framework-independent rules shared by desktop, protocol, and Expo. */
export const rules = {
  eqeqeq: ["error", "always"],
  "no-debugger": "error",
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: ["@/features/*/*", "**/features/*/*"],
          message:
            "Import a feature through its index.ts (@/features/<name>), not its internals.",
        },
      ],
    },
  ],
};
