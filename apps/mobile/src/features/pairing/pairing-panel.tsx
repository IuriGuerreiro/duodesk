import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, space } from "@duodesk/design-tokens";
import { Action, styles } from "@/shared/ui/duo-ui";
import type { NearbyDesktop } from "@duodesk/protocol/discovery";
import type { Nearby } from "./use-nearby";

export type PairingMode = "closed" | "manual" | "scan";
export type PairingPanelProps = {
  address: string;
  setAddress(value: string): void;
  code: string;
  setCode(value: string): void;
  notice: string;
  error: string;
  available: boolean;
  busy: boolean;
  canSubmit: boolean;
  connect(): void;
  acceptScan(text: string): void;
  guardPrompt<T>(request: () => Promise<T>): Promise<T>;
  nearby: Nearby;
  /** Fills the address only; the user still enters the PC's code. */
  selectNearby(device: NearbyDesktop): void;
};

export function PairingScanner({
  connection,
  onBack,
  onManual,
}: {
  connection: PairingPanelProps;
  onBack(): void;
  onManual(): void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [requesting, setRequesting] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const asked = useRef(false);
  async function requestAccess() {
    setRequesting(true);
    try {
      await connection.guardPrompt(requestPermission);
    } catch {
      setCameraError(
        "Camera access failed. Enter the address and code instead.",
      );
    } finally {
      setRequesting(false);
    }
  }
  useEffect(() => {
    if (permission?.status === "undetermined" && !asked.current) {
      asked.current = true;
      void requestAccess();
    }
    // Choosing Scan code is the owner's request to use the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.status]);

  return (
    <View style={styles.scanRoot}>
      {permission?.granted && !cameraError && (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={({ data }) => connection.acceptScan(data)}
          onMountError={() =>
            setCameraError(
              "The camera could not open. Enter the address and code instead.",
            )
          }
        />
      )}
      <SafeAreaView style={styles.scanOverlay}>
        <Text style={styles.scanTitle}>Scan the code on your computer</Text>
        <View style={styles.scanFrame} accessible={false} />
        {cameraError || connection.error ? (
          <Text style={styles.scanError} accessibilityRole="alert">
            {cameraError || connection.error}
          </Text>
        ) : null}
        <View style={styles.scanActions}>
          {!permission?.granted && !cameraError && (
            <>
              <Text style={[styles.lead, { textAlign: "center" }]}>
                Allow camera access to scan the code, or enter the address and
                code instead.
              </Text>
              <Action
                label={
                  permission && !permission.canAskAgain
                    ? "Open camera settings"
                    : "Allow camera access"
                }
                disabled={requesting}
                onPress={() => {
                  if (permission && !permission.canAskAgain)
                    void Linking.openSettings().catch(() =>
                      setCameraError(
                        "Open your phone settings to allow camera access.",
                      ),
                    );
                  else void requestAccess();
                }}
              />
              {requesting && <ActivityIndicator color={colors.blue} />}
            </>
          )}
          <Action
            variant="secondary"
            label="Enter address and code instead"
            onPress={onManual}
          />
          <Action variant="ghost" label="Cancel" onPress={onBack} />
        </View>
      </SafeAreaView>
    </View>
  );
}

export function PairingManual({
  connection,
  onBack,
}: {
  connection: PairingPanelProps;
  onBack(): void;
}) {
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Enter address and code</Text>
        <Text style={styles.lead}>
          Enter the PC address and six-digit code shown in DuoDesk on your
          computer.
        </Text>
        <TextInput
          style={[styles.input, { minHeight: 54 }]}
          value={connection.address}
          onChangeText={connection.setAddress}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="192.168.1.20:39871"
          placeholderTextColor={colors.text3}
          accessibilityLabel="PC address and port"
          editable={!connection.busy}
        />
        <TextInput
          style={[
            styles.input,
            {
              minHeight: 54,
              fontSize: 20,
              letterSpacing: 6,
              textAlign: "center",
            },
          ]}
          value={connection.code}
          onChangeText={connection.setCode}
          keyboardType="number-pad"
          maxLength={6}
          placeholder="000000"
          placeholderTextColor={colors.text3}
          accessibilityLabel="Six-digit verification code"
          editable={!connection.busy}
        />
        {connection.notice ? (
          <Text style={styles.lead}>{connection.notice}</Text>
        ) : null}
        {connection.error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {connection.error}
          </Text>
        ) : null}
        <View style={styles.spacer} />
        <Action
          label={connection.busy ? "Connecting…" : "Connect"}
          disabled={
            !connection.available || connection.busy || !connection.canSubmit
          }
          onPress={connection.connect}
        />
        <Action variant="ghost" label="Back" onPress={onBack} />
        <View style={{ height: space.xs }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const nearbyCopy: Record<Nearby["status"], string> = {
  idle: "",
  searching: "Looking for PCs with a pairing code open.",
  "needs-permission": "Allow local network access to find PCs automatically.",
  denied:
    "Local network access was denied. Allow it in your phone’s app settings, or scan the code instead.",
  unsupported: "",
  error: "Couldn’t search the network. Check Wi-Fi and try again.",
};

/** PCs found on the local network. Choosing one still requires its code. */
export function NearbyList({
  connection,
  onSelect,
}: {
  connection: PairingPanelProps;
  onSelect(): void;
}) {
  const { nearby } = connection;
  if (nearby.status === "idle" || nearby.status === "unsupported") return null;
  const searching = nearby.status === "searching";
  return (
    <View style={styles.stats}>
      <View style={[styles.stat, { alignItems: "center" }]}>
        <Text style={styles.label}>Nearby PCs</Text>
        {searching && <ActivityIndicator size="small" color={colors.blue} />}
      </View>
      {nearby.devices.map((device) => (
        <Pressable
          key={device.id}
          style={styles.stat}
          disabled={!connection.available || connection.busy}
          accessibilityRole="button"
          accessibilityLabel={`${device.name}, ${device.address}. Select, then enter its code.`}
          onPress={() => {
            connection.selectNearby(device);
            onSelect();
          }}
        >
          <Text style={styles.statValue} numberOfLines={1}>
            {device.name}
          </Text>
          <Text style={styles.statLabel}>{device.address}</Text>
        </Pressable>
      ))}
      {(!searching || nearby.devices.length === 0) && (
        <Text
          style={[styles.statLabel, { paddingVertical: space.sm }]}
          accessibilityLiveRegion="polite"
        >
          {nearbyCopy[nearby.status]}
        </Text>
      )}
      {!searching && (
        <Action
          variant="ghost"
          label={
            nearby.status === "needs-permission"
              ? "Find nearby PCs"
              : "Try again"
          }
          onPress={nearby.retry}
        />
      )}
    </View>
  );
}
