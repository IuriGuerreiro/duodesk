import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Text } from "@/shared/ui/text";
import type { NearbyDesktop } from "@duodesk/protocol/discovery";
import type { Nearby } from "./use-nearby";

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
  nearby: Nearby;
  /** Fills the address only; the user still enters the PC's code. */
  selectNearby: (device: NearbyDesktop) => void;
};

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function Icon({
  name,
  color = "#2855D9",
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

export function PairingDeviceLink() {
  return (
    <View
      accessible={false}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      className="h-36 items-center justify-center"
    >
      <View className="absolute h-32 w-72 rounded-full bg-[#E8EDF8]" />
      <View className="flex-row items-center gap-4">
        <View className="h-[104px] w-[58px] rounded-[14px] border-[3px] border-[#526685] bg-background p-1">
          <View className="flex-1 items-center justify-center rounded-lg bg-[#DFE7FA]">
            <View className="absolute top-1 h-1 w-5 rounded-full bg-[#526685]" />
            <Icon name="phone-portrait-outline" size={24} />
          </View>
        </View>
        <View className="flex-row items-center gap-1.5">
          {[0, 1, 2].map((dot) => (
            <View key={dot} className="h-1.5 w-1.5 rounded-full bg-[#9FAEC8]" />
          ))}
          <Icon name="arrow-forward" size={16} color="#7D8CA6" />
        </View>
        <View className="items-center">
          <View className="h-[90px] w-[134px] rounded-xl border-[3px] border-[#526685] bg-white p-1.5">
            <View className="flex-1 items-center justify-center rounded-md bg-[#DFE7FA]">
              <View className="h-10 w-10 items-center justify-center rounded-full bg-[#C4D2EF]">
                <Icon name="desktop-outline" color="#526685" size={22} />
              </View>
            </View>
          </View>
          <View className="h-3 w-2 bg-[#526685]" />
          <View className="h-1 w-12 rounded-full bg-[#526685]" />
        </View>
      </View>
    </View>
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
          <Icon name="close" color="#17243D" />
        </Button>
      </View>
      {permission?.granted && !cameraError ? (
        <View className="overflow-hidden rounded-2xl bg-[#17243D]">
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
        <View className="items-center gap-4 rounded-2xl bg-muted p-5">
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
              {requesting && <ActivityIndicator color="white" />}
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

const nearbyCopy: Record<Nearby["status"], string> = {
  idle: "",
  searching:
    "Looking for PCs with a pairing code open. Choose Create pairing code in DuoDesk on your PC.",
  "needs-permission": "Allow local network access to find PCs automatically.",
  denied:
    "Local network access was denied. Allow it in your phone’s app settings, or scan the QR code instead.",
  unsupported: "",
  error:
    "Couldn’t search the network. Check Wi-Fi and try again, or scan the QR code.",
};

function NearbyList({ connection }: { connection: PairingPanelProps }) {
  const { nearby } = connection;
  if (nearby.status === "idle" || nearby.status === "unsupported") return null;
  const searching = nearby.status === "searching";
  return (
    <View className="gap-2">
      <View className="flex-row items-center gap-2">
        <Text className="flex-1 font-semibold">Nearby PCs</Text>
        {searching && <ActivityIndicator color="#2855D9" />}
      </View>
      {nearby.devices.map((device) => {
        const selected = connection.address === device.address;
        return (
          <Button
            key={device.id}
            variant={selected ? "secondary" : "outline"}
            className="h-auto justify-start py-3"
            disabled={!connection.available || connection.busy}
            accessibilityLabel={`${device.name}, ${device.address}. Select, then enter its code.`}
            onPress={() => connection.selectNearby(device)}
          >
            <Icon name="desktop-outline" size={20} />
            <View className="flex-1">
              <Text className="font-semibold" numberOfLines={1}>
                {device.name}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {device.address}
              </Text>
            </View>
            {selected && <Icon name="checkmark" size={18} />}
          </Button>
        );
      })}
      {(!searching || nearby.devices.length === 0) && (
        <Text
          accessibilityLiveRegion="polite"
          className="text-sm leading-5 text-muted-foreground"
        >
          {nearbyCopy[nearby.status]}
        </Text>
      )}
      {!searching && (
        <Button variant="outline" size="sm" onPress={nearby.retry}>
          <Icon name="refresh" size={18} />
          <Text>
            {nearby.status === "needs-permission"
              ? "Find nearby PCs"
              : "Try again"}
          </Text>
        </Button>
      )}
    </View>
  );
}

export function PairingPanel(connection: PairingPanelProps) {
  if (connection.mode === "scan") return <Scanner connection={connection} />;
  return (
    <View className="gap-5">
      <View className="flex-row items-start gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-xl bg-secondary">
          <Icon name="desktop-outline" />
        </View>
        <View className="flex-1 gap-1">
          <Text className="text-lg font-semibold">Connect to your PC</Text>
          <Text className="text-sm leading-5 text-muted-foreground">
            Open DuoDesk on your PC and create a pairing code.
          </Text>
        </View>
      </View>
      <NearbyList connection={connection} />
      <Button
        disabled={!connection.available || connection.busy}
        onPress={connection.openScanner}
      >
        <Icon name="scan-outline" color="white" />
        <Text>Scan QR code</Text>
        <Icon name="arrow-forward" color="white" size={18} />
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
              <Icon name="close" size={20} color="#5D6B82" />
            </Button>
          </View>
          <Text className="text-sm leading-5 text-muted-foreground">
            Enter the address with its port and the six-digit code shown in
            DuoDesk on your PC.
          </Text>
          <Input
            accessibilityLabel="PC address and port"
            placeholder="192.168.1.20:39871"
            placeholderTextColor="#5D6B82"
            value={connection.address}
            onChangeText={connection.setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!connection.busy}
          />
          <Input
            accessibilityLabel="Six-digit verification code"
            placeholder="Six-digit code"
            placeholderTextColor="#5D6B82"
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
            {connection.connecting && <ActivityIndicator color="white" />}
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
          <Icon name="clipboard-outline" size={19} color="#5D6B82" />
          <Text className="text-muted-foreground">Enter address and code</Text>
        </Button>
      )}
      <View className="flex-row items-center gap-2">
        <Icon name="wifi-outline" size={16} color="#5D6B82" />
        <Text className="flex-1 text-xs leading-5 text-muted-foreground">
          Use the same Wi-Fi or local network on both devices.
        </Text>
      </View>
    </View>
  );
}
