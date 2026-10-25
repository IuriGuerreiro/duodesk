import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Switch,
  Pressable,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import { useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "@duodesk/design-tokens";
import * as sender from "../../../modules/test-video";
import { Action, styles } from "@/shared/ui/duo-ui";
import { useSharedSenderSession } from "./context";

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
  const session = useSharedSenderSession();
  const { status, busy, bitrate, error, setError } = session;
  const [permission, requestPermission] = useCameraPermissions();
  const [details, setDetails] = useState(false);
  async function openScanner() {
    setError("");
    if (
      permission?.granted ||
      (await session.guardPrompt(requestPermission)).granted
    ) {
      session.openScanner();
      router.push("/scan");
    } else
      setError("Camera access is off. Enter the address and code instead.");
  }

  const idle =
    status.state === "idle" ||
    status.state === "failed" ||
    status.state === "stopped";
  const message = error || (status.state === "failed" ? status.message : "");
  const working = busy;

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

        {session.trustNotice ? (
          <Text style={styles.lead}>{session.trustNotice}</Text>
        ) : null}
        {session.audioNotice ? (
          <Text style={styles.lead}>{session.audioNotice}</Text>
        ) : null}
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
            {session.supportsTrustedDevices && (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={styles.lead}>Remember this desktop</Text>
                <Switch
                  value={session.remember}
                  onValueChange={session.setRemember}
                  accessibilityLabel="Remember this desktop"
                />
              </View>
            )}
            {(session.savedDesktops.length > 0 || session.trustError) && (
              <Action
                variant="secondary"
                label="Saved desktops"
                onPress={() => router.push("/saved")}
              />
            )}
            <Action
              label="Scan code"
              disabled={!sender.available}
              onPress={() => void openScanner()}
            />
            <Action
              variant="ghost"
              label="Enter address and code"
              disabled={!sender.available}
              onPress={() => {
                setError("");

                router.push("/paste");
              }}
            />
          </>
        )}

        {(busy || status.state === "connecting") &&
          status.state !== "ready" && (
            <View style={styles.hero}>
              <Text style={styles.title}>Connecting</Text>
              <Text style={styles.lead}>
                to {session.receiver || session.address || "your computer"}
              </Text>
              <Steps
                items={[
                  { label: "Computer found", done: true },
                  { label: "Securing the link", done: false, active: true },
                  { label: "Ready to stream", done: false },
                ]}
              />
              <Action variant="ghost" label="Cancel" onPress={session.stop} />
            </View>
          )}

        {status.state === "ready" && !working && (
          <>
            <View style={styles.hero}>
              <Text style={styles.title}>Connected</Text>
              <Text style={styles.lead}>
                to {session.receiver || session.address || "your computer"}
              </Text>
              <Text style={styles.label}>Quality</Text>
              <View style={styles.segment}>
                {QUALITY.map((option) => (
                  <Pressable
                    key={option.mbps}
                    onPress={() => session.setBitrate(String(option.mbps))}
                    style={[
                      styles.segmentItem,
                      Number(bitrate) === option.mbps && styles.segmentActive,
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{
                      selected: Number(bitrate) === option.mbps,
                    }}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        Number(bitrate) === option.mbps &&
                          styles.segmentTextActive,
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
              label={
                session.supportsScreenSharing
                  ? "Share screen"
                  : "Start streaming"
              }
              onPress={
                session.supportsScreenSharing
                  ? session.startScreen
                  : session.start
              }
            />
            {session.supportsScreenSharing && (
              <Action
                variant="secondary"
                label="Play test video"
                onPress={session.start}
              />
            )}
            {session.supportsPlaybackAudio && (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={styles.lead}>Share phone audio</Text>
                <Switch
                  accessibilityLabel="Share phone audio"
                  value={session.shareAudio}
                  onValueChange={session.setShareAudio}
                />
              </View>
            )}
            <Action variant="ghost" label="Disconnect" onPress={session.stop} />
          </>
        )}

        {status.state === "streaming" && (
          <>
            <View style={[styles.hero, styles.center]}>
              <View style={styles.liveRing}>
                <View style={styles.liveDot} />
              </View>
              <Text style={styles.title}>You’re live</Text>
              <Text style={styles.lead}>
                Streaming to{" "}
                {session.receiver || session.address || "your computer"}
              </Text>
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
              onPress={session.pause}
            />
            <Action
              variant="ghost"
              label="Disconnect"
              disabled={busy}
              onPress={session.stop}
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
