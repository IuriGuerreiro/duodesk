import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Button,
  Platform,
  PermissionsAndroid,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import { SafeAreaView } from "react-native-safe-area-context";
import { parseInvitation } from "@duodesk/protocol";
import * as sender from "../../modules/test-video";
import type { SenderStatus } from "../../modules/test-video";

function PreventSleep() {
  useKeepAwake("duodesk-test-stream");
  return null;
}

function parseBitrate(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 2 || value > 30) {
    throw new Error("Choose a whole number from 2 to 30 Mbps.");
  }
  return value;
}

export default function StreamTestScreen() {
  const [invitation, setInvitation] = useState("");
  const [status, setStatus] = useState<SenderStatus>({ state: "idle" });
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [bitrate, setBitrate] = useState("12");
  const [error, setError] = useState("");

  const statusRef = useRef<SenderStatus>(status);
  const eventSeqRef = useRef<number>(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const syncStatus = useCallback(async () => {
    if (!sender.available) return;
    const seqAtCall = eventSeqRef.current;
    try {
      const snapshot = await sender.getStatus();
      if (eventSeqRef.current === seqAtCall) {
        setStatus(snapshot);
      }
    } catch {
      // Retain existing status if status query fails
    }
  }, []);

  useEffect(() => {
    const subscription = sender.subscribe((nextStatus) => {
      eventSeqRef.current += 1;
      setStatus(nextStatus);
    });

    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        void syncStatus();
      } else if (next === "background") {
        setScanning(false);
        void sender.background();
      }
    });

    return () => {
      subscription.remove();
      appState.remove();
      setScanning(false);
      if (
        statusRef.current.mode !== "screen" ||
        statusRef.current.state !== "streaming"
      ) {
        void sender.background();
      }
    };
  }, [syncStatus]);

  useFocusEffect(
    useCallback(() => {
      void syncStatus();
      return () => {
        setScanning(false);
        if (
          statusRef.current.mode !== "screen" ||
          statusRef.current.state !== "streaming"
        ) {
          void sender.background();
        }
      };
    }, [syncStatus]),
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

  function accept(text: string) {
    try {
      parseInvitation(text);
      setInvitation(text);
      setScanning(false);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid invitation");
    }
  }

  async function scan() {
    if (permission?.granted || (await requestPermission()).granted) {
      setScanning(true);
    } else {
      setError(
        "Camera access is optional. Paste the manual invitation instead.",
      );
    }
  }

  const canConnect =
    status.state === "idle" ||
    status.state === "failed" ||
    status.state === "stopped";

  const shouldKeepAwake =
    sender.available &&
    status.state === "streaming" &&
    status.mode !== "screen";

  const stats = status.stats;

  return (
    <SafeAreaView style={styles.safe}>
      {shouldKeepAwake && <PreventSleep />}
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Mobile → Windows</Text>
        <Text style={styles.text}>
          Stream video to DuoDesk receiver on Windows.
        </Text>
        {!sender.available && (
          <Text style={styles.error}>
            {Platform.OS === "ios" || Platform.OS === "android"
              ? "Rebuild and install the DuoDesk development client to enable the native sender."
              : "The sender is available on Android and iPad/iPhone development builds only."}
          </Text>
        )}
        <Text style={styles.label}>
          1. Create an invitation in the Windows app
        </Text>
        <Button
          title="Scan Windows QR code"
          disabled={!sender.available || !canConnect || busy}
          onPress={() => void run(scan)}
        />
        {scanning && (
          <View>
            <CameraView
              style={styles.camera}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => accept(data)}
            />
            <Button
              title="Cancel scanning"
              disabled={busy}
              onPress={() => setScanning(false)}
            />
          </View>
        )}
        <TextInput
          style={styles.input}
          multiline
          value={invitation}
          onChangeText={setInvitation}
          autoCapitalize="none"
          autoCorrect={false}
          editable={canConnect && !busy}
          placeholder="Or paste the full manual invitation"
          placeholderTextColor="#697386"
          accessibilityLabel="Windows invitation"
        />
        <Button
          title="Connect"
          disabled={
            !sender.available || !canConnect || busy || !invitation.trim()
          }
          onPress={() =>
            void run(async () => {
              parseInvitation(invitation);
              if (Platform.OS === "android" && Number(Platform.Version) >= 37) {
                const result = await PermissionsAndroid.request(
                  PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
                );
                if (result !== PermissionsAndroid.RESULTS.GRANTED) {
                  throw new Error(
                    "Allow local network access to connect to the desktop receiver.",
                  );
                }
              }
              await sender.connect(invitation);
            })
          }
        />
        <Text style={styles.label}>2. Start video stream</Text>
        <Text style={styles.text}>
          Maximum bitrate in Mbps, from 2 to 30. Actual bitrate adapts to the
          connection.
        </Text>
        <TextInput
          style={styles.input}
          value={bitrate}
          onChangeText={setBitrate}
          keyboardType="number-pad"
          editable={(canConnect || status.state === "ready") && !busy}
          accessibilityLabel="Maximum bitrate Mbps"
        />
        {sender.supportsScreenSharing ? (
          <View style={styles.buttonGroup}>
            <Button
              title="Share screen"
              disabled={status.state !== "ready" || busy}
              onPress={() =>
                void run(async () => {
                  const value = parseBitrate(bitrate);
                  if (
                    Platform.OS === "android" &&
                    Number(Platform.Version) >= 33
                  ) {
                    await PermissionsAndroid.request(
                      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
                    );
                  }
                  await sender.startScreen(value);
                })
              }
            />
            <Text style={styles.text}>
              Screen sharing mirrors your display live to Windows. Audio is not
              shared. Sharing continues when you open other apps, and can be
              stopped from the DuoDesk notification or here.
            </Text>
            <Button
              title="Start test clip"
              disabled={status.state !== "ready" || busy}
              onPress={() =>
                void run(async () => {
                  const value = parseBitrate(bitrate);
                  await sender.start(value);
                })
              }
            />
          </View>
        ) : (
          <View style={styles.buttonGroup}>
            {Platform.OS === "android" && sender.available && (
              <Text style={styles.error}>
                Screen sharing requires an updated Android development build.
                Rebuild and install the app to enable screen sharing.
              </Text>
            )}
            <Button
              title="Start test clip"
              disabled={status.state !== "ready" || busy}
              onPress={() =>
                void run(async () => {
                  const value = parseBitrate(bitrate);
                  await sender.start(value);
                })
              }
            />
          </View>
        )}
        <Button
          title="Stop / disconnect"
          disabled={!sender.available || canConnect || busy}
          onPress={() => void run(sender.stop)}
        />
        <Text accessibilityLiveRegion="polite" style={styles.label}>
          Status: {status.state}
          {status.mode
            ? ` (${status.mode === "screen" ? "screen" : "test clip"})`
            : ""}
        </Text>
        {(error || status.message) && (
          <Text style={styles.error}>{error || status.message}</Text>
        )}
        {stats && (
          <Text style={styles.text}>
            {stats.codec} · {stats.width} × {stats.height} ·{" "}
            {Number(stats.fps).toFixed(0)} fps · {Number(stats.mbps).toFixed(2)}{" "}
            Mbps{"\n"}Quality limit: {stats.qualityLimit}
          </Text>
        )}
        <Text style={styles.text}>
          Stopping ends the session. Create a new Windows invitation before
          reconnecting. Android screen sharing can also be stopped from the
          ongoing notification.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f5f8" },
  content: {
    padding: 24,
    paddingBottom: 120,
    gap: 16,
    maxWidth: 650,
    width: "100%",
    alignSelf: "center",
  },
  buttonGroup: {
    gap: 12,
  },
  title: { fontSize: 28, fontWeight: "700", color: "#172238" },
  label: { fontSize: 18, fontWeight: "600", color: "#172238" },
  text: { fontSize: 16, lineHeight: 24, color: "#35445d" },
  input: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#79879d",
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    color: "#172238",
  },
  error: { color: "#a91d29", fontSize: 16, lineHeight: 24 },
  camera: { height: 300, width: "100%" },
});
