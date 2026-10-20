import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "@duodesk/design-tokens";
import * as sender from "../../modules/test-video";
import type { SenderStatus } from "../../modules/test-video";
import { Action, styles } from "@/components/duo-ui";
import { hostOf, setSessionError, useSession } from "@/lib/session";

const QUALITY = [
  { label: "Saver", mbps: 6 },
  { label: "Balanced", mbps: 12 },
  { label: "Sharp", mbps: 20 },
] as const;

function PreventSleep() {
  useKeepAwake("duodesk-stream");
  return null;
}

export default function SenderScreen() {
  const { invitation, connecting, error: pairError } = useSession();
  const [status, setStatus] = useState<SenderStatus>({ state: "idle" });
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [bitrate, setBitrate] = useState(12);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);

  useEffect(() => {
    // Screen sharing keeps running in the background; only leaving the app ends it.
    const subscription = sender.subscribe(setStatus);
    return () => {
      subscription.remove();
      void sender.stop();
    };
  }, []);
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

  async function openScanner() {
    setError("");
    setSessionError("");
    if (permission?.granted || (await requestPermission()).granted)
      router.push("/scan");
    else
      setError("Camera access is off. You can paste the invitation instead.");
  }

  const idle =
    status.state === "idle" ||
    status.state === "failed" ||
    status.state === "stopped";
  const message =
    error || pairError || (status.state === "failed" ? status.message : "");
  const working = busy || connecting;

  return (
    <SafeAreaView style={styles.safe}>
      {!idle && sender.available && <PreventSleep />}
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <View style={styles.brandMark} />
            <Text style={styles.brandText}>DuoDesk</Text>
          </View>
          <StatusPill state={status.state} busy={working} />
        </View>

        {idle && !working && (
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
                setSessionError("");
                router.push("/paste");
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

        {status.state === "ready" && !working && (
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
              label="Stop streaming"
              disabled={busy}
              onPress={() => void run(sender.pause)}
            />
            <Action
              variant="ghost"
              label="Disconnect"
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
