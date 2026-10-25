/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "#0A0A0B",
        foreground: "#FAFAFA",
        primary: { DEFAULT: "#3B82F6", foreground: "#FFFFFF" },
        secondary: { DEFAULT: "#18181B", foreground: "#FAFAFA" },
        muted: { DEFAULT: "#232327", foreground: "#A1A1AA" },
        accent: { DEFAULT: "#18181B", foreground: "#FAFAFA" },
        destructive: "#FCA5A5",
        border: "#2A2A2F",
        input: "#3A3A40",
        ring: "#3B82F6",
      },
    },
  },
  plugins: [],
};
