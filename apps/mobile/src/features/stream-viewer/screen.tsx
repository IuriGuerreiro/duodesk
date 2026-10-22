import { View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useKeepAwake } from "expo-keep-awake";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/shared/ui/button";
import { Text } from "@/shared/ui/text";
import { StreamViewerView } from "../../../modules/test-video";
import { useViewerSession } from "./use-viewer-session";

const copy = {
  idle: {
    title: "Nothing to watch yet.",
    detail:
      "On your PC, choose Share this screen and create a connection. Then scan its QR code on the home screen.",
  },
  connecting: {
    title: "Connecting to your PC.",
    detail: "Keep DuoDesk open on both devices.",
  },
  ready: {
    title: "Connected.",
    detail: "Your PC is starting screen sharing automatically.",
  },
  streaming: {
    title: "Your PC screen.",
    detail: "Live over your local network. Audio is not shared.",
  },
  stopped: {
    title: "Session ended.",
    detail: "Create a new connection on your PC to watch again.",
  },
  failed: {
    title: "Connection lost.",
    detail: "Create a new connection on your PC and scan it again.",
  },
} as const;

function KeepAwake() {
  useKeepAwake("duodesk-viewer", { suppressDeactivateWarnings: true });
  return null;
}

export default function StreamViewerScreen() {
  const session = useViewerSession();
  const { status } = session;
  const text = copy[status.state];
  const stats = status.stats;
  const live = status.state === "streaming";
  const watching =
    status.state === "connecting" || status.state === "ready" || live;
  return (
    <SafeAreaView className="flex-1 bg-background">
      {watching && <KeepAwake />}
      <View className="mx-auto w-full max-w-xl flex-1 gap-5 px-6 pt-3">
        <View className="gap-3">
          <Text
            accessibilityRole="header"
            className="text-[34px] font-bold leading-[40px] tracking-tight"
          >
            {text.title}
          </Text>
          <Text className="text-base leading-6 text-muted-foreground">
            {text.detail}
          </Text>
        </View>
        {watching && (
          <View
            accessibilityLabel="Your PC screen"
            className="aspect-video w-full overflow-hidden rounded-2xl bg-black"
          >
            <StreamViewerView style={{ flex: 1 }} />
            {!live && (
              <View className="absolute inset-0 items-center justify-center bg-black px-6">
                <Text className="text-center text-base text-white">
                  Waiting for your PC to start sharing…
                </Text>
              </View>
            )}
          </View>
        )}
        {live && stats && (
          <Text className="text-xs text-muted-foreground">
            {`${stats.width} × ${stats.height} · ${Number(stats.fps).toFixed(0)} fps · ${stats.codec.replace("video/", "")} · ${Number(stats.mbps).toFixed(1)} Mbps`}
          </Text>
        )}
        {session.error ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            className="text-sm leading-5 text-destructive"
          >
            {session.error}
          </Text>
        ) : null}
        <View className="mt-auto flex-row items-center gap-2 pb-2">
          <Ionicons
            name="shield-checkmark-outline"
            size={15}
            color="#5D6B82"
            accessible={false}
            aria-hidden
          />
          <Text className="flex-1 text-xs text-muted-foreground">
            Direct from your PC. No cloud video.
          </Text>
        </View>
        <Button
          variant={watching ? "destructive" : "outline"}
          className="mb-4"
          onPress={session.stop}
        >
          <Text>{watching ? "Stop watching" : "Back"}</Text>
        </Button>
      </View>
    </SafeAreaView>
  );
}
