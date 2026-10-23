import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Switch,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useKeepAwake } from "expo-keep-awake";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Text } from "@/shared/ui/text";
import { cn } from "@/shared/lib/utils";
import { PairingDeviceLink, PairingPanel } from "@/features/pairing";
import { useSenderSession } from "./use-sender-session";
import { controlCopy, screenStreamingCopy, sessionCopy } from "./session-copy";

type SenderSession = ReturnType<typeof useSenderSession>;
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

function Session({ connection }: { connection: SenderSession }) {
  const { status } = connection;
  const stats = status.stats;
  const screenMode = status.mode === "screen" || connection.screenIntent;
  const starting =
    connection.negotiatingVideo ||
    connection.operation === "start" ||
    connection.operation === "screen";
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
              starting
                ? screenMode
                  ? "Starting screen sharing"
                  : "Starting test video"
                : "Connecting to PC"
            }
            color="#2855D9"
          />
        )}
      </View>
      <View className="gap-4 border-t border-border pt-5">
        <View className="flex-row items-center justify-between gap-3">
          <View className="flex-1 gap-1">
            <Text className="font-semibold">
              {screenMode ? "Screen sharing" : "Test video"}
            </Text>
            <Text className="text-sm text-muted-foreground">
              {screenMode
                ? "Live display mirror"
                : "Bundled clip · 1080p target"}
            </Text>
          </View>
          <View className="rounded-lg bg-secondary px-2.5 py-1.5">
            <Text className="text-xs font-semibold text-secondary-foreground">
              {screenMode
                ? status.audio === "active"
                  ? "VIDEO + AUDIO"
                  : "NO AUDIO"
                : "VIDEO ONLY"}
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
        {status.state === "ready" && connection.supportsPlaybackAudio && (
          <View className="gap-2">
            <View className="flex-row items-center gap-3">
              <Text className="flex-1 text-sm font-semibold">
                Share phone audio
              </Text>
              <Switch
                accessibilityLabel="Share phone audio when sharing the screen"
                value={connection.shareAudio}
                onValueChange={connection.setShareAudio}
                disabled={connection.busy}
              />
            </View>
            <Text className="text-xs leading-5 text-muted-foreground">
              Sends sound from other apps, not your microphone. Android asks for
              the microphone permission because it requires it for any audio
              capture. Calls and apps that block capture stay silent.
            </Text>
          </View>
        )}
        {screenMode && connection.audioNotice ? (
          <Text className="text-xs leading-5 text-muted-foreground">
            {connection.audioNotice}
          </Text>
        ) : null}
        {screenMode && status.audioMessage ? (
          <Text className="text-xs leading-5 text-muted-foreground">
            {status.audioMessage}
          </Text>
        ) : null}
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
              {stats.audioKbps !== undefined
                ? ` · Audio ${Number(stats.audioKbps).toFixed(0)} kbps`
                : ""}
            </Text>
          </View>
        )}
        {screenMode &&
          status.state === "streaming" &&
          connection.supportsRemoteControl && (
            <RemoteControlCard connection={connection} />
          )}
        {status.state === "connecting" && (
          <Text
            accessibilityLiveRegion="polite"
            className="text-sm leading-6 text-muted-foreground"
          >
            {starting
              ? screenMode
                ? "Starting screen sharing. Waiting for your PC…"
                : "Starting the test video. Waiting for your PC…"
              : "Verifying the code. Waiting for your PC…"}
          </Text>
        )}
      </View>
      <Text className="text-xs leading-5 text-muted-foreground">
        {screenMode && status.state === "streaming"
          ? "Sharing continues when you open other apps. Stop it here or from the DuoDesk notification. Reconnecting needs a new pairing code."
          : "Keep DuoDesk open. Leaving the app ends this session. Reconnecting needs a new pairing code."}
      </Text>
    </View>
  );
}

function RemoteControlCard({ connection }: { connection: SenderSession }) {
  const copy = controlCopy(connection.status.control);
  if (!copy) return null;
  const on = copy.state === "on";
  const press =
    copy.action === "allow"
      ? connection.allowControl
      : copy.action === "stop"
        ? connection.stopControl
        : connection.openAccessibilitySettings;
  return (
    <View
      className={cn(
        "gap-3 rounded-xl border p-4",
        on ? "border-[#B9E0D3] bg-[#F1FAF6]" : "border-border bg-white",
      )}
    >
      <View
        accessibilityLiveRegion="polite"
        className="flex-row items-center gap-3"
      >
        <Icon
          name={on ? "hand-left" : "hand-left-outline"}
          color={on ? "#147D64" : "#2855D9"}
        />
        <Text className="flex-1 font-semibold">{copy.title}</Text>
      </View>
      <Text className="text-sm leading-5 text-muted-foreground">
        {copy.detail}
      </Text>
      <Button
        variant={on ? "destructive" : "outline"}
        disabled={connection.controlBusy}
        onPress={press}
      >
        <Text>{copy.buttonLabel}</Text>
      </Button>
    </View>
  );
}

function SessionControls({ connection }: { connection: SenderSession }) {
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
        {status.state === "ready" && connection.supportsScreenSharing && (
          <Button disabled={connection.busy} onPress={connection.startScreen}>
            <Icon name="phone-portrait-outline" color="white" size={19} />
            <Text>Share screen</Text>
          </Button>
        )}
        {status.state === "ready" && (
          <Button
            variant={connection.supportsScreenSharing ? "outline" : "default"}
            disabled={connection.busy}
            onPress={connection.start}
          >
            <Icon
              name="play"
              color={connection.supportsScreenSharing ? "#17243D" : "white"}
              size={19}
            />
            <Text>Start test video</Text>
          </Button>
        )}
        {status.state === "ready" &&
          !connection.supportsScreenSharing &&
          Platform.OS === "android" &&
          connection.available && (
            <Text className="text-xs leading-5 text-muted-foreground">
              Screen sharing needs an updated Android development build. Rebuild
              and install the app to enable it.
            </Text>
          )}
        {status.state === "streaming" && (
          <Button
            variant="destructive"
            disabled={connection.busy}
            onPress={connection.pause}
          >
            <Icon name="stop" color="white" size={18} />
            <Text>Stop streaming</Text>
          </Button>
        )}
        <Button
          variant="outline"
          size={status.state === "ready" ? "sm" : "default"}
          disabled={stopping}
          onPress={connection.stop}
        >
          {stopping ? (
            <ActivityIndicator color="#2855D9" />
          ) : (
            <Icon name="close" color="#17243D" size={18} />
          )}
          <Text>
            {stopping
              ? "Ending session…"
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

export default function StreamSenderScreen() {
  const connection = useSenderSession();
  const [help, setHelp] = useState(false);
  const sharingScreen =
    connection.status.mode === "screen" &&
    connection.status.state === "streaming";
  const copy = sharingScreen
    ? screenStreamingCopy(connection.status.audio)
    : sessionCopy[connection.status.state];
  const error =
    connection.error ||
    (connection.status.state === "failed" ? connection.status.message : "");
  return (
    <SafeAreaView className="flex-1 bg-background">
      {!connection.canPair &&
        connection.available &&
        connection.status.mode !== "screen" && <PreventSleep />}
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
                  1. Open DuoDesk on your PC.{`\n`}2. Create a pairing code.
                  {`\n`}3. Scan its QR code, or enter the address and six-digit
                  code here.
                </Text>
                <Text className="text-sm leading-6 text-muted-foreground">
                  Codes expire quickly and work once. If one fails, create a new
                  one. Both devices must be on the same local network. Check the
                  PC firewall if connecting times out.
                </Text>
                <Text className="text-sm leading-6 text-muted-foreground">
                  Screen sharing mirrors your display without audio, where the
                  build supports it. The test video is a bundled clip.
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
                  ? connection.screenIntent
                    ? "Getting your\nscreen ready."
                    : "Getting your\nvideo ready."
                  : copy.title}
              </Text>
              <Text className="max-w-sm text-base leading-6 text-muted-foreground">
                {connection.negotiatingVideo
                  ? connection.screenIntent
                    ? "The PC is connected. Setting up screen sharing."
                    : "The PC is connected. Setting up the test video stream."
                  : copy.detail}
              </Text>
            </View>
            {connection.canPair && connection.mode !== "scan" && (
              <PairingDeviceLink />
            )}
            {error && connection.canPair ? (
              <Notice title="Couldn’t complete that" error>
                {error}
              </Notice>
            ) : null}
            <View className="gap-5 rounded-3xl border border-white bg-white p-5">
              {connection.canPair ? (
                <PairingPanel
                  mode={connection.mode}
                  setMode={connection.setMode}
                  address={connection.address}
                  setAddress={connection.setAddress}
                  code={connection.code}
                  setCode={connection.setCode}
                  notice={connection.notice}
                  available={connection.available}
                  busy={connection.busy}
                  canSubmit={connection.canSubmit}
                  connecting={connection.operation === "connect"}
                  connect={connection.connect}
                  openScanner={connection.openScanner}
                  closeScanner={connection.closeScanner}
                  acceptScan={connection.acceptScan}
                  guardPrompt={connection.guardPrompt}
                />
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
