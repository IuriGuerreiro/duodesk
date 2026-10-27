import { useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { router } from "expo-router";
import { useKeepAwake } from "expo-keep-awake";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, space } from "@duodesk/design-tokens";
import { Action, styles } from "@/shared/ui/duo-ui";
import { NearbyList } from "@/features/pairing";
import { useSenderConnection } from "./session-context";

const SETTINGS_FIELDS = [
  { key: "maxLongSide", label: "Max width" },
  { key: "maxShortSide", label: "Max height" },
  { key: "frameRate", label: "Max fps" },
] as const;

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
  const connection = useSenderConnection();
  const status = connection.status;
  const [details, setDetails] = useState(false);
  const idle = connection.canPair;
  const working = connection.busy;
  const busy =
    connection.busy || connection.remoteAccessBusy || connection.controlBusy;
  const bitrate = Number(connection.bitrate);
  const receiver = connection.receiver || "your PC";
  const starting =
    connection.operation === "screen" ||
    connection.operation === "start" ||
    connection.negotiatingVideo;
  const message =
    connection.error || (status.state === "failed" ? status.message : "");
  const screen = status.mode === "screen";
  const controlling = status.control?.state === "on";

  function openScanner() {
    connection.openScanner();
    router.push("/scan");
  }
  function openManual() {
    connection.setError("");
    connection.setMode("manual");
    router.push("/paste");
  }

  return (
    <SafeAreaView style={styles.safe}>
      {!idle && connection.available && status.mode !== "screen" && (
        <PreventSleep />
      )}
      <ScrollView
        contentContainerStyle={[styles.content, { flexGrow: 1 }]}
        keyboardShouldPersistTaps="handled"
      >
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
              {!connection.available && (
                <Text style={styles.error}>
                  {Platform.OS === "ios" || Platform.OS === "android"
                    ? "Rebuild and install the DuoDesk development client to enable streaming."
                    : "Streaming works in the Android and iOS apps only."}
                </Text>
              )}
              {message ? <Text style={styles.error}>{message}</Text> : null}
            </View>
            <NearbyList
              connection={connection}
              onSelect={() => router.push("/paste")}
            />
            <Action
              label="Scan code"
              disabled={!connection.available}
              onPress={openScanner}
            />
            <Action
              variant="ghost"
              label="Enter address and code"
              disabled={!connection.available}
              onPress={openManual}
            />
          </>
        )}

        {(working || status.state === "connecting") &&
          status.state !== "streaming" && (
            <View style={styles.hero}>
              <Text style={styles.title}>
                {starting ? "Starting your stream" : "Connecting"}
              </Text>
              <Text style={styles.lead}>to {receiver}</Text>
              <Steps
                items={[
                  { label: "Computer found", done: true },
                  {
                    label: "Securing the link",
                    done: starting,
                    active: !starting,
                  },
                  { label: "Ready to stream", done: false, active: starting },
                ]}
              />
            </View>
          )}

        {status.state === "ready" && !working && (
          <>
            <View style={styles.hero}>
              <Text style={styles.title}>Connected</Text>
              <Text style={styles.lead}>to {receiver}</Text>
              <Text style={styles.label}>Quality</Text>
              <View style={styles.segment}>
                {QUALITY.map((option) => (
                  <Pressable
                    key={option.mbps}
                    onPress={() => connection.setBitrate(String(option.mbps))}
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
              {connection.remoteAccessStep === "settings" && (
                <Text style={[styles.lead, { marginTop: space.md }]}>
                  Enable DuoDesk in Accessibility settings, then return here.
                </Text>
              )}
              {message ? <Text style={styles.error}>{message}</Text> : null}
            </View>
            {connection.supportsPlaybackAudio && (
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingVertical: space.sm,
                }}
              >
                <Text style={styles.lead}>Share phone audio</Text>
                <Switch
                  accessibilityLabel="Share phone audio"
                  value={connection.shareAudio}
                  onValueChange={connection.setShareAudio}
                  trackColor={{ false: colors.surface3, true: colors.blue }}
                  thumbColor={colors.text}
                  ios_backgroundColor={colors.surface3}
                />
              </View>
            )}
            {connection.supportsScreenSharing && (
              <View style={{ gap: space.sm, paddingVertical: space.sm }}>
                <Text style={styles.label}>Screen picture (max)</Text>
                <View style={{ flexDirection: "row", gap: space.sm }}>
                  {SETTINGS_FIELDS.map((field) => (
                    <TextInput
                      key={field.key}
                      style={[styles.input, { flex: 1 }]}
                      value={connection.streamSettings[field.key]}
                      onChangeText={(text) =>
                        connection.setStreamSettings({ [field.key]: text })
                      }
                      keyboardType="number-pad"
                      placeholder={field.label}
                      placeholderTextColor={colors.text3}
                      accessibilityLabel={field.label}
                      editable={!busy}
                    />
                  ))}
                </View>
                <Text
                  style={connection.settingsError ? styles.error : styles.lead}
                >
                  {connection.settingsError ||
                    "Width × height × fps. Your screen is scaled down to fit, keeping its shape; portrait swaps width and height."}
                </Text>
              </View>
            )}
            {connection.supportsScreenSharing && (
              <Action
                label="Share screen"
                disabled={busy || !!connection.settingsError}
                onPress={connection.startScreen}
              />
            )}
            {connection.supportsRemoteControl && (
              <Action
                variant="secondary"
                label={
                  connection.remoteAccessBusy
                    ? "Starting remote access…"
                    : "Remote access"
                }
                disabled={busy}
                onPress={connection.requestRemoteAccess}
              />
            )}
            <Action
              variant="ghost"
              label="Start test video"
              disabled={busy}
              onPress={connection.start}
            />
            <Action
              variant="ghost"
              label="Disconnect"
              onPress={connection.stop}
            />
          </>
        )}

        {status.state === "streaming" && (
          <>
            <View style={[styles.hero, styles.center]}>
              <View style={styles.liveRing}>
                <View style={styles.liveDot} />
              </View>
              <Text style={styles.title}>
                {controlling ? "Remote access is on" : "You’re live"}
              </Text>
              <Text style={styles.lead}>Streaming to {receiver}</Text>
              {screen && (
                <Text
                  style={[
                    styles.lead,
                    { textAlign: "center", marginTop: space.sm },
                  ]}
                >
                  {controlling
                    ? "Your PC can tap and swipe."
                    : "Your screen is being shared."}
                </Text>
              )}
              {screen && (connection.audioNotice || status.audioMessage) ? (
                <Text
                  style={[
                    styles.lead,
                    { textAlign: "center", marginTop: space.sm },
                  ]}
                >
                  {connection.audioNotice || status.audioMessage}
                </Text>
              ) : null}
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
                    label="Sending"
                    value={`${status.stats.width} × ${status.stats.height}`}
                  />
                  <Stat
                    label="Frame rate"
                    value={`${Number(status.stats.fps).toFixed(0)} fps`}
                  />
                  {status.stats.screenFps !== undefined && (
                    <Stat
                      label="Screen changes"
                      value={
                        status.stats.screenFps > 0
                          ? `${Number(status.stats.screenFps).toFixed(0)} fps`
                          : "Screen idle"
                      }
                    />
                  )}
                  <Stat
                    label="Bitrate"
                    value={`${Number(status.stats.mbps).toFixed(1)} Mbps`}
                  />
                  <Stat label="Codec" value={status.stats.codec} />
                  {status.requested && (
                    <Stat
                      label="Requested"
                      value={`≤ ${status.requested.maxLongSide} × ${status.requested.maxShortSide} · ${status.requested.frameRate} fps`}
                    />
                  )}
                  {status.capture && (
                    <Stat
                      label="Capturing"
                      value={`${status.capture.width} × ${status.capture.height}`}
                    />
                  )}
                  <Stat label="Limited by" value={status.stats.qualityLimit} />
                </View>
              )}
            </View>
            {screen && connection.supportsRemoteControl && (
              <Action
                variant="secondary"
                label={
                  controlling
                    ? "Stop remote access"
                    : connection.remoteAccessBusy
                      ? "Starting remote access…"
                      : "Remote access"
                }
                disabled={busy}
                onPress={
                  controlling
                    ? connection.stopControl
                    : connection.requestRemoteAccess
                }
              />
            )}
            {message ? <Text style={styles.error}>{message}</Text> : null}
            <Action
              variant="danger"
              label="Stop streaming"
              disabled={busy}
              onPress={connection.pause}
            />
            <Action
              variant="ghost"
              label="Disconnect"
              disabled={busy}
              onPress={connection.stop}
            />
          </>
        )}
      </ScrollView>
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
