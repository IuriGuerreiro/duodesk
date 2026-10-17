import { useCallback, useEffect, useState } from "react";
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

export default function StreamTestScreen() {
  const [invitation, setInvitation] = useState("");
  const [status, setStatus] = useState<SenderStatus>({ state: "idle" });
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<"screen" | "clip">(
    Platform.OS === "android" ? "screen" : "clip",
  );
  const [bitrate, setBitrate] = useState("12");
  const [error, setError] = useState("");

  useEffect(() => {
    const subscription = sender.subscribe(setStatus);
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "background") {
        setScanning(false);
        if (Platform.OS !== "android") void sender.stop();
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
        setScanning(false);
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
    if (permission?.granted || (await requestPermission()).granted)
      setScanning(true);
    else
      setError(
        "Camera access is optional. Paste the manual invitation instead.",
      );
  }
  const canConnect =
    status.state === "idle" ||
    status.state === "failed" ||
    status.state === "stopped";
  const stats = status.stats;
  return (
    <SafeAreaView style={styles.safe}>
      {!canConnect && sender.available && <PreventSleep />}
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Mobile → Windows</Text>
        <Text style={styles.text}>
          {Platform.OS === "android"
            ? "Share your Android screen with Windows. Android will ask what to share. You can switch apps while sharing. No audio is sent."
            : "Send the bundled 1080p test pattern. Keep DuoDesk open during this test."}
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
          disabled={!sender.available || !canConnect || busy || !invitation}
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
        <Text style={styles.label}>2. Choose a video source</Text>
        {Platform.OS === "android" && (
          <View style={{ gap: 8 }}>
            <Button
              title={source === "screen" ? "✓ Live screen" : "Live screen"}
              disabled={busy || (!canConnect && status.state !== "ready")}
              onPress={() => setSource("screen")}
            />
            <Button
              title={
                source === "clip"
                  ? "✓ Diagnostic test clip"
                  : "Diagnostic test clip"
              }
              disabled={busy || (!canConnect && status.state !== "ready")}
              onPress={() => setSource("clip")}
            />
          </View>
        )}
        <Text style={styles.text}>
          Maximum bitrate in Mbps, from 2 to 30. Actual bitrate adapts to the
          connection.
        </Text>
        <TextInput
          style={styles.input}
          value={bitrate}
          onChangeText={setBitrate}
          keyboardType="number-pad"
          editable={canConnect || status.state === "ready"}
          accessibilityLabel="Maximum bitrate Mbps"
        />
        <Button
          title={source === "screen" ? "Share screen" : "Start test clip"}
          disabled={status.state !== "ready" || busy}
          onPress={() =>
            void run(async () => {
              const value = Number(bitrate);
              if (!Number.isInteger(value) || value < 2 || value > 30)
                throw new Error("Choose a whole number from 2 to 30 Mbps.");
              await sender.start(value, source);
            })
          }
        />
        <Button
          title="Stop / disconnect"
          disabled={!sender.available || canConnect}
          onPress={() => void run(sender.stop)}
        />
        <Text accessibilityLiveRegion="polite" style={styles.label}>
          Status: {status.state}
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
          Stopping or leaving this screen ends the session. Create a new Windows
          invitation before reconnecting. Android screen sharing also ends from
          the sharing notification or Android sharing controls. The diagnostic
          clip stops when DuoDesk goes into the background.
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
