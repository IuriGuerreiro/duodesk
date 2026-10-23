import { colors } from "@duodesk/design-tokens";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Text } from "@/shared/ui/text";

export type PairingMode = "closed" | "manual" | "scan";

export type PairingPanelProps = {
  mode: PairingMode;
  setMode: (mode: PairingMode) => void;
  address: string;
  setAddress: (value: string) => void;
  code: string;
  setCode: (value: string) => void;
  notice: string;
  available: boolean;
  busy: boolean;
  canSubmit: boolean;
  connecting: boolean;
  connect: () => void;
  openScanner: () => void;
  closeScanner: () => void;
  acceptScan: (text: string) => void;
  /** Wraps a system permission dialog so the app leaving the foreground for it is not treated as abandoning pairing. */
  guardPrompt: <T>(request: () => Promise<T>) => Promise<T>;
};

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function Icon({
  name,
  color = colors.text2,
  size = 22,
}: {
  name: IconName;
  color?: string;
  size?: number;
}) {
  return (
    <Ionicons
      name={name}
      size={size}
      color={color}
      accessible={false}
      aria-hidden
    />
  );
}

function Scanner({ connection }: { connection: PairingPanelProps }) {
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

  // Choosing "Scan QR code" is the user's request to use the camera, so ask
  // once right away instead of showing a second button first.
  useEffect(() => {
    if (permission?.status === "undetermined" && !asked.current) {
      asked.current = true;
      void requestAccess();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.status]);

  return (
    <View className="gap-4">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-xl font-semibold">
          Scan your PC’s QR code
        </Text>
        <Button
          variant="ghost"
          size="icon"
          accessibilityLabel="Close scanner"
          onPress={connection.closeScanner}
        >
          <Icon name="close" color={colors.text} />
        </Button>
      </View>
      {permission?.granted && !cameraError ? (
        <View className="overflow-hidden rounded-card border border-border bg-surface-raised">
          <CameraView
            style={{ height: 280, width: "100%" }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => connection.acceptScan(data)}
            onMountError={() =>
              setCameraError(
                "The camera could not open. Enter the address and code instead.",
              )
            }
          />
          <Text className="px-4 py-3 text-center text-sm leading-5 text-white">
            Point at the code in DuoDesk on your PC.
          </Text>
        </View>
      ) : (
        <View className="items-center gap-4 rounded-card bg-muted p-5">
          <Icon name="camera-outline" size={36} />
          <Text className="text-center leading-6 text-muted-foreground">
            {cameraError ||
              "Allow camera access to scan the QR code. You can also enter the address and six-digit code without using the camera."}
          </Text>
          {!cameraError && (
            <Button
              className="self-stretch"
              disabled={requesting}
              onPress={() => {
                if (permission && !permission.canAskAgain) {
                  void Linking.openSettings().catch(() =>
                    setCameraError(
                      "Open your phone settings to allow camera access, or enter the address and code.",
                    ),
                  );
                } else void requestAccess();
              }}
            >
              {requesting && <ActivityIndicator color={colors.text} />}
              <Text>
                {permission && !permission.canAskAgain
                  ? "Open camera settings"
                  : "Allow camera access"}
              </Text>
            </Button>
          )}
        </View>
      )}
      <Button
        variant="outline"
        onPress={() => {
          connection.closeScanner();
          connection.setMode("manual");
        }}
      >
        <Text>Enter the code instead</Text>
      </Button>
    </View>
  );
}

export function PairingPanel(connection: PairingPanelProps) {
  if (connection.mode === "scan") return <Scanner connection={connection} />;
  return (
    <View className="gap-5">
      <Button
        variant={connection.mode === "manual" ? "ghost" : "default"}
        disabled={!connection.available || connection.busy}
        onPress={connection.openScanner}
      >
        <Icon name="scan-outline" color={colors.text} />
        <Text>Scan QR code</Text>
        <Icon name="arrow-forward" color={colors.text} size={18} />
      </Button>
      {connection.mode === "manual" ? (
        <View className="gap-3 border-t border-border pt-4">
          <View className="flex-row items-center justify-between">
            <Text className="font-semibold">PC address and code</Text>
            <Button
              variant="ghost"
              size="icon"
              accessibilityLabel="Close manual entry"
              onPress={() => connection.setMode("closed")}
            >
              <Icon name="close" size={20} color={colors.text2} />
            </Button>
          </View>
          <Text className="text-sm leading-5 text-muted-foreground">
            Enter the address with its port and the six-digit code shown in
            DuoDesk on your PC.
          </Text>
          <Input
            accessibilityLabel="PC address and port"
            placeholder="192.168.1.20:39871"
            placeholderTextColor={colors.text3}
            value={connection.address}
            onChangeText={connection.setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!connection.busy}
          />
          <Input
            accessibilityLabel="Six-digit verification code"
            placeholder="000000"
            className="text-center font-mono text-xl tracking-[6px]"
            placeholderTextColor={colors.text3}
            value={connection.code}
            onChangeText={connection.setCode}
            keyboardType="number-pad"
            maxLength={6}
            editable={!connection.busy}
          />
          {connection.notice ? (
            <Text
              accessibilityLiveRegion="polite"
              className="text-sm leading-5 text-muted-foreground"
            >
              {connection.notice}
            </Text>
          ) : null}
          <Button
            disabled={
              !connection.available || connection.busy || !connection.canSubmit
            }
            onPress={() => connection.connect()}
          >
            {connection.connecting && <ActivityIndicator color={colors.text} />}
            <Text>
              {connection.connecting ? "Connecting…" : "Connect to PC"}
            </Text>
          </Button>
        </View>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          onPress={() => connection.setMode("manual")}
        >
          <Icon name="clipboard-outline" size={19} color={colors.text2} />
          <Text className="text-muted-foreground">Enter address and code</Text>
        </Button>
      )}
      <View className="flex-row items-center gap-2">
        <Icon name="wifi-outline" size={16} color={colors.text2} />
        <Text className="flex-1 text-xs leading-5 text-muted-foreground">
          Use the same Wi-Fi or local network on both devices.
        </Text>
      </View>
    </View>
  );
}
