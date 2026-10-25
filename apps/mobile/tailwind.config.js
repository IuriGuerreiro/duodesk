const { colors, radius } = require("@duodesk/design-tokens");

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: colors.background,
        foreground: colors.text,
        surface: {
          DEFAULT: colors.surface1,
          raised: colors.surface2,
          hover: colors.surface3,
        },
        primary: {
          DEFAULT: colors.blue,
          foreground: colors.text,
          hover: colors.blueHover,
        },
        secondary: { DEFAULT: colors.surface3, foreground: colors.text },
        muted: { DEFAULT: colors.surface2, foreground: colors.text2 },
        accent: { DEFAULT: colors.surface3, foreground: colors.text },
        destructive: colors.danger,
        border: colors.border,
        input: colors.borderStrong,
        ring: colors.blue,
      },
      borderRadius: {
        control: `${radius.control}px`,
        card: `${radius.card}px`,
      },
    },
  },
  plugins: [],
};
