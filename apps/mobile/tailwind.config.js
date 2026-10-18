/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        background: "#F3F5F9",
        foreground: "#17243D",
        primary: { DEFAULT: "#2855D9", foreground: "#FFFFFF" },
        secondary: { DEFAULT: "#E8EEFC", foreground: "#2449AD" },
        muted: { DEFAULT: "#EDF0F5", foreground: "#5D6B82" },
        accent: { DEFAULT: "#E8EEFC", foreground: "#2449AD" },
        destructive: "#B42339",
        border: "#D9DFE9",
        input: "#B9C4D5",
        ring: "#2855D9",
      },
    },
  },
  plugins: [],
};
