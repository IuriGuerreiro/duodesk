import { Pressable, StyleSheet, Text } from "react-native";
import { colors, radius, space } from "@duodesk/design-tokens";

export function Action({
  label,
  onPress,
  disabled,
  variant = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={[styles.action, styles[variant], disabled && styles.disabled]}
    >
      <Text
        style={[
          styles.actionText,
          variant === "ghost" && { color: colors.text2 },
          variant === "danger" && { color: colors.danger },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  content: {
    flexGrow: 1,
    padding: space.xl,
    paddingBottom: space.xxl,
    gap: space.md,
    maxWidth: 560,
    width: "100%",
    alignSelf: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandMark: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.text,
    borderLeftWidth: 6,
    borderLeftColor: colors.blue,
  },
  brandText: { color: colors.text, fontSize: 16, fontWeight: "600" },
  hero: { flex: 1, justifyContent: "center", gap: space.sm },
  center: { alignItems: "center" },
  display: {
    color: colors.text,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: "600",
    letterSpacing: -0.9,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  lead: { color: colors.text2, fontSize: 16, lineHeight: 24 },
  label: {
    color: colors.text3,
    fontSize: 13,
    fontWeight: "600",
    marginTop: space.xl,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  error: {
    color: "#FCA5A5",
    fontSize: 15,
    lineHeight: 22,
    marginTop: space.sm,
  },
  spacer: { flex: 1, minHeight: space.lg },
  input: {
    minHeight: 120,
    marginTop: space.lg,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.control,
    padding: 14,
    fontSize: 14,
    color: colors.text,
    textAlignVertical: "top",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    height: 28,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
  },
  pillLive: {
    backgroundColor: colors.blueSoft,
    borderColor: "rgba(59,130,246,0.35)",
  },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillText: { color: colors.text2, fontSize: 12.5, fontWeight: "600" },
  steps: {
    marginTop: space.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    backgroundColor: colors.surface1,
  },
  step: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  stepIcon: { width: 20, textAlign: "center", fontSize: 15, fontWeight: "700" },
  stepText: { fontSize: 15 },
  segment: {
    flexDirection: "row",
    padding: 4,
    gap: 4,
    borderRadius: radius.control + 2,
    backgroundColor: colors.surface1,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segmentItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: radius.control - 2,
  },
  segmentActive: { backgroundColor: colors.surface3 },
  segmentText: { color: colors.text3, fontSize: 14, fontWeight: "600" },
  segmentTextActive: { color: colors.text },
  liveRing: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.blueSoft,
    marginBottom: space.lg,
  },
  liveDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.blue,
  },
  chip: {
    marginTop: space.lg,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface2,
  },
  chipText: { color: colors.text2, fontSize: 13, fontWeight: "600" },
  stats: {
    alignSelf: "stretch",
    marginTop: space.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    backgroundColor: colors.surface1,
    paddingHorizontal: space.lg,
  },
  stat: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  statLabel: { color: colors.text3, fontSize: 14 },
  statValue: { color: colors.text, fontSize: 14, fontWeight: "500" },
  action: {
    height: 54,
    borderRadius: radius.card,
    alignItems: "center",
    justifyContent: "center",
  },
  primary: { backgroundColor: colors.blue },
  secondary: {
    backgroundColor: "rgba(24,24,27,0.9)",
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  ghost: { backgroundColor: "transparent" },
  danger: {
    backgroundColor: "rgba(239,68,68,0.1)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.35)",
  },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },
  actionText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  scanRoot: { flex: 1, backgroundColor: "#000" },
  scanOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "space-between",
    padding: space.xl,
  },
  scanTitle: {
    marginTop: space.xl,
    color: "#fff",
    fontSize: 18,
    fontWeight: "600",
    textAlign: "center",
  },
  scanFrame: {
    width: 248,
    height: 248,
    borderRadius: 28,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.9)",
  },
  scanError: {
    color: "#FCA5A5",
    fontSize: 15,
    textAlign: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
    padding: space.sm,
    borderRadius: radius.control,
  },
  scanActions: { alignSelf: "stretch", gap: space.sm },
});
