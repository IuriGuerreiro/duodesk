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
import { parsePairingQrPayload } from "@duodesk/protocol/pairing";
import { pairWithCode } from "../pairing/connect";
import * as sender from "../../modules/test-video";
import type { SenderStatus } from "../../modules/test-video";

async function localNetworkPermission() {
  if (Platform.OS === "android" && Number(Platform.Version) >= 37) {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
    );
    if (result !== PermissionsAndroid.RESULTS.GRANTED)
      throw new Error(
        "Allow local network access to connect to the desktop receiver.",
      );
  }
}

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
  const generation = useRef(0);
  const running = useRef(false);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [scanNotice, setScanNotice] = useState("");
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
    const lifecycle = generation;
    const subscription = sender.subscribe((nextStatus) => {
      eventSeqRef.current += 1;
      setStatus(nextStatus);
    });

    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        void syncStatus();
      } else if (next === "background") {
        generation.current++;
        void sender.pairClose();
        setScanning(false);
        void sender.background();
      }
    });

    return () => {
      lifecycle.current++;
      void sender.pairClose();
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
        generation.current++;
        void sender.pairClose();
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
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function accept(text: string) {
    try {
      const pairing = parsePairingQrPayload(text);
      setAddress(pairing.address);
      setCode(pairing.code);
      setScanning(false);
      setError("");
      setScanNotice("Address and code filled. Tap Verify code and connect.");
    } catch (cause) {
      setScanNotice("");
      setError(cause instanceof Error ? cause.message : "Invalid pairing QR.");
    }
  }

  async function scan() {
    setScanNotice("");
    const active = generation.current;
    const granted = permission?.granted || (await requestPermission()).granted;
    if (generation.current !== active) return;
    if (granted) setScanning(true);
    else {
      setError(
        "Camera access is optional. Use the desktop address and six-digit code instead.",
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
        <Text style={styles.title}>Mobile → desktop</Text>
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
          1. Create a pairing code in the desktop app
        </Text>
        <Text style={styles.text}>
          Scan the desktop QR to fill the address and six-digit code, or enter
          them below.
        </Text>
        <Button
          title="Scan pairing QR"
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
        <Text style={styles.text}>
          Use the desktop address including its port. Both devices must be on
          the same local network.
        </Text>
        <TextInput
          style={styles.input}
          value={address}
          onChangeText={(value) => {
            setAddress(value);
            setScanNotice("");
          }}
          autoCapitalize="none"
          autoCorrect={false}
          editable={canConnect && !busy}
          placeholder="192.168.1.20:39871"
          placeholderTextColor="#697386"
          accessibilityLabel="Desktop address and port"
        />
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={(value) => {
            setCode(value);
            setScanNotice("");
          }}
          keyboardType="number-pad"
          maxLength={6}
          editable={canConnect && !busy}
          placeholder="Six-digit code"
          placeholderTextColor="#697386"
          accessibilityLabel="Six-digit verification code"
        />
        <Button
          title="Verify code and connect"
          disabled={
            !sender.available ||
            !canConnect ||
            busy ||
            !address ||
            code.length !== 6 ||
            !/^[0-9]{6}$/.test(code)
          }
          onPress={() =>
            void run(async () => {
              const active = ++generation.current;
              await localNetworkPermission();
              if (generation.current !== active) return;
              const text = await pairWithCode(
                address.trim(),
                code,
                () => generation.current !== active,
              );
              if (generation.current !== active) return;
              setCode("");
              await sender.connect(text);
            })
          }
        />
        {!!scanNotice && <Text style={styles.text}>{scanNotice}</Text>}
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
          disabled={!sender.available || (canConnect && !busy)}
          onPress={() => {
            generation.current++;
            void sender.pairClose();
            void sender.stop();
          }}
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
          Stopping ends the session. Create a new desktop pairing code before
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
