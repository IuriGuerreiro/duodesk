import { useState } from "react";
import {
  ScrollView,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  PermissionsAndroid,
  Platform,
} from "react-native";
import { Link } from "expo-router";
import { useRemembered } from "@/features/remembered";
import * as native from "../../modules/test-video";

export default function Devices() {
  const { status, error, busy, enroll, pendingRequest, command, refresh } =
    useRemembered();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  async function find() {
    if (Platform.OS === "android" && Number(Platform.Version) >= 37) {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK,
      );
      if (result !== PermissionsAndroid.RESULTS.GRANTED) return;
    }
    await command("foreground", { active: true });
    await refresh();
  }
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={busy || disabled}
      onPress={action}
      style={[styles.button, (busy || disabled) && styles.disabled]}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Link href="/" style={styles.text}>
        ← Back to sharing
      </Link>
      <Text style={styles.title}>Remembered devices</Text>
      <Text style={styles.text}>
        Trust skips the pairing code. Each new session still needs approval.
        Keep DuoDesk open on both devices.
      </Text>
      {!native.supportsRemembered && (
        <Text style={styles.text}>
          Install an updated development build to remember devices.
        </Text>
      )}
      {status.error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {status.error}
        </Text>
      )}
      <TextInput
        accessibilityLabel="Device name"
        placeholder="Friendly name for this PC"
        placeholderTextColor="#999"
        style={styles.input}
        maxLength={40}
        value={name}
        onChangeText={setName}
      />
      {button(
        "Remember paired PC",
        () => void command("enroll", { action: "start", name }),
        enroll !== "capable",
      )}
      {enroll && (
        <Text style={styles.text}>
          {{
            capable: "Ready to remember the paired PC.",
            requested: "Waiting for PC approval.",
            verifying: "Verifying and saving trust…",
            saved: "PC remembered.",
            failed: "Could not remember. Pair again.",
            cancelled: "Remember request cancelled.",
          }[enroll] ?? ""}
        </Text>
      )}
      {button("Find remembered PCs", () => void find(), !status.available)}
      {pendingRequest && (
        <>
          {button(
            "Cancel connection request",
            () => void command("cancel", { requestId: pendingRequest }),
          )}
          <Text style={styles.text}>Waiting for PC approval.</Text>
        </>
      )}
      {!status.devices.length && (
        <Text style={styles.text}>
          No remembered PCs yet. Pair using a code or QR first.
        </Text>
      )}
      {status.devices.map((device) => (
        <ScrollView key={device.id} horizontal={false} style={styles.device}>
          <Text style={styles.name}>{device.name}</Text>
          <Text style={styles.text}>
            {device.available
              ? "Available"
              : "Unavailable. Open DuoDesk on the PC and check its remembered-device network."}
          </Text>
          {button(
            "Connect to PC",
            () =>
              void command("connect", {
                deviceId: device.id,
                direction: "phone-to-desktop",
              }),
            !device.available || !!pendingRequest,
          )}
          {native.supportsViewing &&
            button(
              "View desktop",
              () =>
                void command("connect", {
                  deviceId: device.id,
                  direction: "desktop-to-phone",
                }),
              !device.available || !!pendingRequest,
            )}
          {button(
            "Rename using name above",
            () => void command("rename", { deviceId: device.id, name }),
            !name.trim(),
          )}
          {button(
            "Forget",
            () => void command("forget", { deviceId: device.id }),
          )}
        </ScrollView>
      ))}
      <Text style={styles.text}>
        If discovery is blocked, enter the remembered-device address shown on
        the PC. Identity is always checked.
      </Text>
      <TextInput
        accessibilityLabel="Remembered PC address"
        autoCapitalize="none"
        placeholder="192.168.1.20:12345"
        placeholderTextColor="#999"
        style={styles.input}
        value={address}
        onChangeText={setAddress}
      />
      {button(
        "Check address",
        () => void command("link", { address }),
        !address || !status.available,
      )}
      <Link href="/paste" style={styles.text}>
        Pair again with a fresh code
      </Link>
      {error && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  page: { padding: 24, paddingTop: 64, gap: 16, backgroundColor: "#0A0A0B" },
  title: { color: "#fff", fontSize: 28, fontWeight: "600" },
  text: { color: "#ddd", fontSize: 15, lineHeight: 22 },
  name: { color: "#fff", fontSize: 20 },
  error: { color: "#ffaaaa", fontSize: 15 },
  input: {
    color: "#fff",
    padding: 14,
    borderWidth: 1,
    borderColor: "#444",
    borderRadius: 8,
  },
  button: {
    padding: 14,
    backgroundColor: "#242428",
    borderRadius: 8,
    marginVertical: 4,
  },
  disabled: { opacity: 0.4 },
  device: { paddingVertical: 16, borderTopWidth: 1, borderTopColor: "#333" },
});
