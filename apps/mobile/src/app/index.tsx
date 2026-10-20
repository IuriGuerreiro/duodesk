import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  PermissionsAndroid,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import { SafeAreaView } from "react-native-safe-area-context";
import { parseInvitation } from "@duodesk/protocol";
import { colors, radius, space } from "@duodesk/design-tokens";
import * as sender from "../../modules/test-video";
import type { SenderStatus } from "../../modules/test-video";

type Screen = "home" | "scan" | "paste";

const QUALITY = [
  { label: "Saver", mbps: 6 },
  { label: "Balanced", mbps: 12 },
  { label: "Sharp", mbps: 20 },
] as const;

function PreventSleep() {
  useKeepAwake("duodesk-stream");
  return null;
}

/** Desktop address shown while connecting, so the user knows which PC it is. */
function hostOf(invitation: string) {
  try {
    return new URL(parseInvitation(invitation).url).hostname;
  } catch {
    return "your computer";
  }
}

export default function SenderScreen() {
  const [screen, setScreen] = useState<Screen>("home");
  const [invitation, setInvitation] = useState("");
  const [status, setStatus] = useState<SenderStatus>({ state: "idle" });
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [bitrate, setBitrate] = useState(12);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);

  useEffect(() => {
    const subscription = sender.subscribe(setStatus);
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "background") {
        setScreen("home");
        void sender.stop();
      }
    });
    return () => {
      subscription.remove();
      appState.remove();
      void sender.stop();
    };
  }, []);
  useFocusEffect(
    useCallback(
      () => () => {
        setScreen("home");
        void sender.stop();
      },
      [],
    ),
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function connect(text: string) {
    parseInvitation(text);
    if (Platform.OS === "android" && Number(Platform.Version) >= 37) {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
      );
      if (result !== PermissionsAndroid.RESULTS.GRANTED)
        throw new Error(
          "Allow local network access to connect to your computer.",
        );
    }
    await sender.connect(text);
  }

  function accept(text: string) {
    if (busy) return;
    try {
      parseInvitation(text);
    } catch {
      setError("That QR code isn't a DuoDesk code. Try again.");
      return;
    }
    Vibration.vibrate(30);
    setInvitation(text);
    setScreen("home");
    void run(() => connect(text));
  }

  async function openScanner() {
    setError("");
    if (permission?.granted || (await requestPermission()).granted)
      setScreen("scan");
    else
      setError("Camera access is off. You can paste the invitation instead.");
  }

  const idle =
    status.state === "idle" ||
    status.state === "failed" ||
    status.state === "stopped";
  const message = error || (status.state === "failed" ? status.message : "");

  if (screen === "scan")
    return (
      <View style={styles.scanRoot}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => accept(data)}
        />
        <SafeAreaView style={styles.scanOverlay}>
          <Text style={styles.scanTitle}>Scan the code on your computer</Text>
          <View style={styles.scanFrame} />
          {error ? <Text style={styles.scanError}>{error}</Text> : null}
          <View style={styles.scanActions}>
            <Action
              variant="secondary"
              label="Enter invitation instead"
              onPress={() => {
                setError("");
                setScreen("paste");
              }}
            />
            <Action
              variant="ghost"
              label="Cancel"
              onPress={() => {
                setError("");
                setScreen("home");
              }}
            />
          </View>
        </SafeAreaView>
      </View>
    );

  if (screen === "paste")
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Enter invitation</Text>
          <Text style={styles.lead}>
            On your computer, open “Can’t scan? Copy the invitation”, then paste
            it here.
          </Text>
          <TextInput
            style={styles.input}
            multiline
            value={invitation}
            onChangeText={setInvitation}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Paste invitation"
            placeholderTextColor={colors.text3}
            accessibilityLabel="Desktop invitation"
          />
          {message ? <Text style={styles.error}>{message}</Text> : null}
          <View style={styles.spacer} />
          <Action
            label="Connect"
            disabled={!invitation || busy}
            onPress={() =>
              void run(async () => {
                await connect(invitation);
                setScreen("home");
              })
            }
          />
          <Action
            variant="ghost"
            label="Back"
            onPress={() => setScreen("home")}
          />
        </ScrollView>
      </SafeAreaView>
    );

  return (
    <SafeAreaView style={styles.safe}>
      {!idle && sender.available && <PreventSleep />}
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <View style={styles.brandMark} />
            <Text style={styles.brandText}>DuoDesk</Text>
          </View>
          <StatusPill state={status.state} busy={busy} />
        </View>

        {idle && !busy && (
          <>
            <View style={styles.hero}>
              <Text style={styles.display}>
                {status.state === "failed"
                  ? "Let's reconnect"
                  : "Your phone, on your big screen."}
              </Text>
              <Text style={styles.lead}>
                Open DuoDesk on your computer, press Create connection, then
                scan the code.
              </Text>
              {!sender.available && (
                <Text style={styles.error}>
                  {Platform.OS === "ios" || Platform.OS === "android"
                    ? "Rebuild and install the DuoDesk development client to enable streaming."
                    : "Streaming works in the Android and iOS apps only."}
                </Text>
              )}
              {message ? <Text style={styles.error}>{message}</Text> : null}
            </View>
            <Action
              label="Scan code"
              disabled={!sender.available}
              onPress={() => void openScanner()}
            />
            <Action
              variant="ghost"
              label="Enter invitation instead"
              disabled={!sender.available}
              onPress={() => {
                setError("");
                setScreen("paste");
              }}
            />
          </>
        )}

        {(busy || status.state === "connecting") &&
          status.state !== "ready" && (
            <View style={styles.hero}>
              <Text style={styles.title}>Connecting</Text>
              <Text style={styles.lead}>to {hostOf(invitation)}</Text>
              <Steps
                items={[
                  { label: "Computer found", done: true },
                  { label: "Securing the link", done: false, active: true },
                  { label: "Ready to stream", done: false },
                ]}
              />
            </View>
          )}

        {status.state === "ready" && !busy && (
          <>
            <View style={styles.hero}>
              <Text style={styles.title}>Connected</Text>
              <Text style={styles.lead}>to {hostOf(invitation)}</Text>
              <Text style={styles.label}>Quality</Text>
              <View style={styles.segment}>
                {QUALITY.map((option) => (
                  <Pressable
                    key={option.mbps}
                    onPress={() => setBitrate(option.mbps)}
                    style={[
                      styles.segmentItem,
                      bitrate === option.mbps && styles.segmentActive,
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: bitrate === option.mbps }}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        bitrate === option.mbps && styles.segmentTextActive,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {message ? <Text style={styles.error}>{message}</Text> : null}
            </View>
            <Action
              label="Start streaming"
              onPress={() => void run(() => sender.start(bitrate))}
            />
            <Action
              variant="ghost"
              label="Disconnect"
              onPress={() => void run(sender.stop)}
            />
          </>
        )}

        {status.state === "streaming" && (
          <>
            <View style={[styles.hero, styles.center]}>
              <View style={styles.liveRing}>
                <View style={styles.liveDot} />
              </View>
              <Text style={styles.title}>You’re live</Text>
              <Text style={styles.lead}>Streaming to {hostOf(invitation)}</Text>
              <Pressable
                onPress={() => setDetails((value) => !value)}
                style={styles.chip}
                accessibilityRole="button"
              >
                <Text style={styles.chipText}>
                  {details ? "Hide details" : "Details"}
                </Text>
              </Pressable>
              {details && status.stats && (
                <View style={styles.stats}>
                  <Stat
                    label="Resolution"
                    value={`${status.stats.width} × ${status.stats.height}`}
                  />
                  <Stat
                    label="Frame rate"
                    value={`${Number(status.stats.fps).toFixed(0)} fps`}
                  />
                  <Stat
                    label="Bitrate"
                    value={`${Number(status.stats.mbps).toFixed(1)} Mbps`}
                  />
                  <Stat label="Codec" value={status.stats.codec} />
                  <Stat label="Limited by" value={status.stats.qualityLimit} />
                </View>
              )}
            </View>
            <Action
              variant="danger"
              label="Stop"
              disabled={busy}
              onPress={() => void run(sender.stop)}
            />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

function StatusPill({ state, busy }: { state: string; busy: boolean }) {
  const live = state === "streaming";
  const label = live
    ? "Live"
    : busy || state === "connecting"
      ? "Connecting"
      : state === "ready"
        ? "Connected"
        : state === "failed"
          ? "Failed"
          : "Not connected";
  const dot = live
    ? colors.blue
    : state === "failed"
      ? colors.danger
      : state === "ready"
        ? colors.success
        : busy || state === "connecting"
          ? colors.warning
          : colors.text3;
  return (
    <View
      style={[styles.pill, live && styles.pillLive]}
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.pillDot, { backgroundColor: dot }]} />
      <Text style={[styles.pillText, live && { color: "#BFDBFE" }]}>
        {label}
      </Text>
    </View>
  );
}

function Steps({
  items,
}: {
  items: { label: string; done: boolean; active?: boolean }[];
}) {
  return (
    <View style={styles.steps}>
      {items.map((item) => (
        <View key={item.label} style={styles.step}>
          {item.active ? (
            <ActivityIndicator size="small" color={colors.blue} />
          ) : (
            <Text
              style={[
                styles.stepIcon,
                { color: item.done ? colors.success : colors.text3 },
              ]}
            >
              {item.done ? "✓" : "○"}
            </Text>
          )}
          <Text
            style={[
              styles.stepText,
              { color: item.done ? colors.text : colors.text2 },
            ]}
          >
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function Action({
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
      style={({ pressed }) => [
        styles.action,
        styles[variant],
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
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

const styles = StyleSheet.create({
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
