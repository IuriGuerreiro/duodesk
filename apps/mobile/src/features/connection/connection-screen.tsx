import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useKeepAwake } from "expo-keep-awake";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";
import { useConnection } from "./use-connection";
import { sessionCopy } from "./session-copy";

type Connection = ReturnType<typeof useConnection>;
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

function PreventSleep() {
  useKeepAwake("duodesk-test-stream", { suppressDeactivateWarnings: true });
  return null;
}

function Notice({
  title,
  children,
  error = false,
}: {
  title: string;
  children: string;
  error?: boolean;
}) {
  return (
    <View
      accessibilityRole={error ? "alert" : undefined}
      accessibilityLiveRegion="polite"
      className={cn(
        "flex-row gap-3 rounded-2xl border p-4",
        error ? "border-[#F1C5CD] bg-[#FFF3F5]" : "border-border bg-white",
      )}
    >
      <Icon
        name={error ? "alert-circle-outline" : "information-circle-outline"}
        color={error ? "#B42339" : "#5D6B82"}
      />
      <View className="flex-1 gap-1">
        <Text
          className={cn("text-sm font-semibold", error && "text-destructive")}
        >
          {title}
        </Text>
        <Text
          className={cn(
            "text-sm leading-5 text-muted-foreground",
            error && "text-[#8B2334]",
          )}
        >
          {children}
        </Text>
      </View>
    </View>
  );
}

function DeviceLink() {
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

function Scanner({ connection }: { connection: Connection }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [requesting, setRequesting] = useState(false);
  const [cameraError, setCameraError] = useState("");

  async function requestAccess() {
    setRequesting(true);
    try {
      await requestPermission();
    } catch {
      setCameraError("Camera access failed. Paste an invitation instead.");
    } finally {
      setRequesting(false);
    }
  }

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
                "The camera could not open. Paste an invitation instead.",
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
              "Allow camera access to scan an invitation. You can also paste one without using the camera."}
          </Text>
          {!cameraError && (
            <Button
              className="self-stretch"
              disabled={requesting}
              onPress={() => {
                if (permission && !permission.canAskAgain) {
                  void Linking.openSettings().catch(() =>
                    setCameraError(
                      "Open your phone settings to allow camera access, or paste an invitation.",
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
        <Text>Paste an invitation instead</Text>
      </Button>
    </View>
  );
}

function Pairing({ connection }: { connection: Connection }) {
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
            Open DuoDesk on your PC and create an invitation.
          </Text>
        </View>
      </View>
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
            <Text className="font-semibold">PC invitation</Text>
            <Button
              variant="ghost"
              size="icon"
              accessibilityLabel="Close manual invitation"
              onPress={() => connection.setMode("closed")}
            >
              <Icon name="close" size={20} color="#5D6B82" />
            </Button>
          </View>
          <Text className="text-sm leading-5 text-muted-foreground">
            Copy the full manual invitation from your PC and paste it here.
          </Text>
          <Input
            accessibilityLabel="PC invitation"
            placeholder="Paste the full invitation…"
            placeholderTextColor="#5D6B82"
            multiline
            textAlignVertical="top"
            className="min-h-28 leading-6"
            value={connection.invitation}
            onChangeText={connection.setInvitation}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={2049}
            editable={!connection.busy}
          />
          <Button
            disabled={
              !connection.available ||
              connection.busy ||
              !connection.invitation.trim()
            }
            onPress={() => connection.connect()}
          >
            {connection.operation === "connect" && (
              <ActivityIndicator color="white" />
            )}
            <Text>
              {connection.operation === "connect"
                ? "Connecting…"
                : "Connect to PC"}
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
          <Text className="text-muted-foreground">Paste an invitation</Text>
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

function Session({ connection }: { connection: Connection }) {
  const { status } = connection;
  const stats = status.stats;
  const starting =
    connection.negotiatingVideo || connection.operation === "start";
  return (
    <View className="gap-5">
      <View className="flex-row items-center gap-3">
        <View className="h-12 w-12 items-center justify-center rounded-xl bg-secondary">
          <Icon name="desktop-outline" size={26} />
        </View>
        <View className="flex-1 gap-1">
          <Text className="text-lg font-semibold">
            {status.state === "connecting" && !starting
              ? "Connecting to PC"
              : "Your PC"}
          </Text>
          <Text selectable className="text-sm text-muted-foreground">
            {connection.receiver || "Local receiver"}
          </Text>
        </View>
        {status.state === "connecting" && (
          <ActivityIndicator
            accessibilityLabel={
              starting ? "Starting test video" : "Connecting to PC"
            }
            color="#2855D9"
          />
        )}
      </View>
      <View className="gap-4 border-t border-border pt-5">
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1 gap-1">
            <Text className="font-semibold">Test video</Text>
            <Text className="text-sm text-muted-foreground">
              Bundled clip · 1080p target
            </Text>
          </View>
          <View className="rounded-lg bg-secondary px-2.5 py-1.5">
            <Text className="text-xs font-semibold text-secondary-foreground">
              VIDEO ONLY
            </Text>
          </View>
        </View>
        {status.state === "ready" && (
          <View className="gap-2">
            <View className="flex-row items-center gap-3">
              <Text className="flex-1 text-sm text-muted-foreground">
                Maximum bitrate
              </Text>
              <Input
                className="w-20 text-center"
                accessibilityLabel="Maximum bitrate in Mbps"
                value={connection.bitrate}
                onChangeText={connection.setBitrate}
                keyboardType="number-pad"
                maxLength={2}
                editable={!connection.busy}
                selectTextOnFocus
              />
              <Text className="text-sm text-muted-foreground">Mbps</Text>
            </View>
            <Text className="text-xs leading-5 text-muted-foreground">
              2–30 Mbps. Actual quality adapts to your connection.
            </Text>
          </View>
        )}
        {status.state === "streaming" && !stats && (
          <Text className="text-sm text-muted-foreground">
            Waiting for stream statistics…
          </Text>
        )}
        {stats && status.state === "streaming" && (
          <View className="gap-3 rounded-xl bg-muted p-4">
            <View className="flex-row flex-wrap gap-x-6 gap-y-3">
              <Metric
                value={`${stats.width} × ${stats.height}`}
                label={stats.codec}
              />
              <Metric
                value={`${Number(stats.fps).toFixed(0)} fps`}
                label="Frame rate"
              />
              <Metric
                value={`${Number(stats.mbps).toFixed(2)}`}
                label="Mbps sent"
              />
            </View>
            <Text className="text-xs text-muted-foreground">
              Quality limit: {stats.qualityLimit}
            </Text>
          </View>
        )}
        {status.state === "connecting" && (
          <Text
            accessibilityLiveRegion="polite"
            className="text-sm leading-6 text-muted-foreground"
          >
            {starting
              ? "Starting the test video. Waiting for your PC…"
              : "Waiting for your PC to accept the invitation…"}
          </Text>
        )}
      </View>
      <Text className="text-xs leading-5 text-muted-foreground">
        Keep DuoDesk open. Leaving the app ends this session. Reconnecting needs
        a new PC invitation.
      </Text>
    </View>
  );
}

function SessionControls({ connection }: { connection: Connection }) {
  const { status } = connection;
  const stopping = connection.operation === "stop";
  return (
    <View className="border-t border-border bg-background px-6 pb-2 pt-3">
      <View className="mx-auto w-full max-w-xl gap-2">
        {connection.error ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            className="text-sm leading-5 text-destructive"
          >
            {connection.error}
          </Text>
        ) : null}
        {status.state === "ready" && (
          <Button disabled={connection.busy} onPress={connection.start}>
            <Icon name="play" color="white" size={19} />
            <Text>Start test video</Text>
          </Button>
        )}
        <Button
          variant={status.state === "streaming" ? "destructive" : "outline"}
          size={status.state === "ready" ? "sm" : "default"}
          disabled={stopping}
          onPress={connection.stop}
        >
          {stopping ? (
            <ActivityIndicator
              color={status.state === "streaming" ? "white" : "#2855D9"}
            />
          ) : (
            <Icon
              name={status.state === "streaming" ? "stop" : "close"}
              color={status.state === "streaming" ? "white" : "#17243D"}
              size={18}
            />
          )}
          <Text>
            {stopping
              ? "Ending session…"
              : status.state === "streaming"
                ? "Stop & disconnect"
                : status.state === "connecting"
                  ? "Cancel connection"
                  : "Disconnect"}
          </Text>
        </Button>
      </View>
    </View>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <View className="gap-1">
      <Text className="text-lg font-semibold tabular-nums">{value}</Text>
      <Text className="text-xs text-muted-foreground">{label}</Text>
    </View>
  );
}

export default function ConnectionScreen() {
  const connection = useConnection();
  const [help, setHelp] = useState(false);
  const copy = sessionCopy[connection.status.state];
  const error =
    connection.error ||
    (connection.status.state === "failed" ? connection.status.message : "");
  return (
    <SafeAreaView className="flex-1 bg-background">
      {!connection.canPair && connection.available && <PreventSleep />}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ flexGrow: 1, paddingBottom: 32 }}
        >
          <View className="mx-auto w-full max-w-xl flex-1 gap-5 px-6 pt-3">
            <View className="flex-row items-center justify-between">
              <View
                className="flex-row items-center gap-2.5"
                accessibilityLabel="DuoDesk"
              >
                <View
                  accessible={false}
                  className="h-9 w-9 flex-row items-center justify-center gap-1 rounded-xl bg-primary"
                >
                  <View className="h-4 w-2 rounded-sm bg-white" />
                  <View className="h-5 w-2 rounded-sm bg-[#AFC4FF]" />
                </View>
                <Text className="text-xl font-bold tracking-tight">
                  duodesk<Text className="text-primary">.</Text>
                </Text>
              </View>
              <Button
                variant="ghost"
                size="icon"
                accessibilityLabel={
                  help ? "Close connection help" : "Connection help"
                }
                accessibilityState={{ expanded: help }}
                onPress={() => setHelp(!help)}
              >
                <Icon
                  name={help ? "close" : "help-circle-outline"}
                  color="#5D6B82"
                  size={25}
                />
              </Button>
            </View>
            {help && (
              <View className="gap-3 rounded-2xl border border-border bg-white p-5">
                <Text
                  className="text-lg font-semibold"
                  accessibilityRole="header"
                >
                  Two devices, one connection
                </Text>
                <Text className="text-sm leading-6 text-muted-foreground">
                  1. Open DuoDesk on your Windows PC.{`\n`}2. Create an
                  invitation.{`\n`}3. Scan its QR code or paste the full
                  invitation here.
                </Text>
                <Text className="text-sm leading-6 text-muted-foreground">
                  Invitations expire quickly. If one fails, create a new one.
                  Both devices must be on the same local network. Check the PC
                  firewall if connecting times out.
                </Text>
                <Text className="text-sm leading-6 text-muted-foreground">
                  This build sends a bundled test video. It does not capture
                  your phone screen or audio.
                </Text>
              </View>
            )}
            <View className="gap-4 pt-1">
              <View
                className="flex-row items-center gap-2"
                accessibilityLiveRegion="polite"
              >
                <View
                  className={cn(
                    "h-2 w-2 rounded-full",
                    copy.tone === "green"
                      ? "bg-[#147D64]"
                      : copy.tone === "red"
                        ? "bg-destructive"
                        : copy.tone === "blue"
                          ? "bg-primary"
                          : "bg-[#7C8BA3]",
                  )}
                />
                <Text
                  className={cn(
                    "text-xs font-semibold uppercase tracking-widest",
                    copy.tone === "green"
                      ? "text-[#147D64]"
                      : copy.tone === "red"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {copy.label}
                </Text>
              </View>
              <Text
                accessibilityRole="header"
                className="text-[34px] font-bold leading-[40px] tracking-tight"
              >
                {connection.negotiatingVideo
                  ? "Getting your\nvideo ready."
                  : copy.title}
              </Text>
              <Text className="max-w-sm text-base leading-6 text-muted-foreground">
                {connection.negotiatingVideo
                  ? "The PC is connected. Setting up the test video stream."
                  : copy.detail}
              </Text>
            </View>
            {connection.canPair && connection.mode !== "scan" && <DeviceLink />}
            {error && connection.canPair ? (
              <Notice title="Couldn’t complete that" error>
                {error}
              </Notice>
            ) : null}
            <View className="gap-5 rounded-3xl border border-white bg-white p-5">
              {connection.canPair ? (
                <Pairing connection={connection} />
              ) : (
                <Session connection={connection} />
              )}
            </View>
            {!connection.available && (
              <Notice title="Streaming unavailable in this build">
                {Platform.OS === "web"
                  ? "Connect and stream from the DuoDesk Android or iOS app. This browser preview shows the interface only."
                  : "Install a DuoDesk development build with the native video sender to connect and stream."}
              </Notice>
            )}
            <View className="mt-auto flex-row items-center justify-center gap-2 pt-2">
              <Icon name="shield-checkmark-outline" size={15} color="#5D6B82" />
              <Text className="text-xs text-muted-foreground">
                Direct to your PC. No cloud video.
              </Text>
            </View>
          </View>
        </ScrollView>
        {!connection.canPair && <SessionControls connection={connection} />}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
