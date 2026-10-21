/** DuoDesk design tokens. Keep in sync with tokens.css. */
export const colors = {
  background: "#0A0A0B",
  surface1: "#111113",
  surface2: "#18181B",
  surface3: "#232327",
  border: "#2A2A2F",
  borderStrong: "#3A3A40",
  text: "#FAFAFA",
  text2: "#A1A1AA",
  text3: "#71717A",
  blue: "#3B82F6",
  blueHover: "#2563EB",
  blueSoft: "rgba(59, 130, 246, 0.14)",
  success: "#22C55E",
  warning: "#F59E0B",
  danger: "#EF4444",
} as const;

export const radius = { control: 10, card: 14, pill: 999 } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const type = {
  display: { fontSize: 32, fontWeight: "600", letterSpacing: -0.9 },
  title: { fontSize: 22, fontWeight: "600", letterSpacing: -0.4 },
  body: { fontSize: 15, fontWeight: "400" },
  small: { fontSize: 13, fontWeight: "400" },
  code: { fontSize: 20, fontWeight: "600" },
} as const;

export const motion = { fast: 150, base: 220 } as const;
