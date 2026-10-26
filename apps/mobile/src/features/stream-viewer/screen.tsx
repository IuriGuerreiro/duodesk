import { useEffect, useState } from "react";
import { Pressable, View, type LayoutChangeEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useKeepAwake } from "expo-keep-awake";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/shared/ui/button";
import { Text } from "@/shared/ui/text";
import { StreamViewerView, supportsViewing } from "../../../modules/test-video";
import { useViewerSession } from "./use-viewer-session";
import { useViewportGestures } from "./use-viewport-gestures";
import {
  clampViewport,
  frameFor,
  initialViewport,
  isReset,
  toggleMode,
  type Size,
} from "./viewport";

const copy = {
  idle: {
    title: "Nothing to watch yet.",
    detail:
      "On your PC, choose Share this screen and create a connection. Then scan its QR code on the home screen.",
  },
  connecting: {
    title: "Connecting to your PC…",
    detail: "Keep DuoDesk open on both devices.",
  },
  ready: {
    title: "Connected.",
    detail: "Waiting for your PC to start sharing…",
  },
  streaming: { title: "Your PC screen", detail: "" },
  stopped: {
    title: "Session ended.",
    detail: "Create a new connection on your PC to watch again.",
  },
  failed: {
    title: "Connection lost.",
    detail: "Create a new connection on your PC and scan it again.",
  },
} as const;

const unsupported = {
  title: "Viewing isn't available here.",
  detail: "Watching your PC screen works in the DuoDesk Android app.",
};

const HIDE_CONTROLS_MS = 3500;

function KeepAwake() {
  useKeepAwake("duodesk-viewer", { suppressDeactivateWarnings: true });
  return null;
}

function ControlButton(props: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress(): void;
  tone?: "danger";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      hitSlop={6}
      className={
        props.tone === "danger"
          ? "h-11 flex-row items-center gap-2 rounded-full bg-destructive/80 px-4 active:bg-destructive"
          : "h-11 flex-row items-center gap-2 rounded-full bg-black/60 px-4 active:bg-black/80"
      }
    >
      <Ionicons name={props.icon} size={18} color="#fff" aria-hidden />
      <Text className="text-sm font-medium text-white">{props.label}</Text>
    </Pressable>
  );
}

export default function StreamViewerScreen() {
  const session = useViewerSession();
  const { status } = session;
  const insets = useSafeAreaInsets();
  const [container, setContainer] = useState<Size>({ width: 0, height: 0 });
  const [viewport, setViewport] = useState(initialViewport);
  const [controlsVisible, setControlsVisible] = useState(true);

  const live = status.state === "streaming";
  const watching =
    status.state === "connecting" || status.state === "ready" || live;
  const stats = status.stats;
  const video: Size = {
    width: stats?.width ?? 0,
    height: stats?.height ?? 0,
  };

  // Rotation or a new desktop resolution can leave the old pan out of range.
  const clamped = clampViewport(viewport, container, video);
  const frame = frameFor(clamped, container, video);

  const gestures = useViewportGestures({
    viewport: clamped,
    container,
    video,
    onChange: setViewport,
    onTap: () => setControlsVisible((visible) => !visible),
    onReset: () => setViewport(initialViewport(clamped.mode)),
  });

  useEffect(() => {
    if (!live || !controlsVisible) return;
    const timer = setTimeout(() => setControlsVisible(false), HIDE_CONTROLS_MS);
    return () => clearTimeout(timer);
  }, [live, controlsVisible, viewport]);

  const showControls = controlsVisible || !live;
  const message = supportsViewing ? copy[status.state] : unsupported;

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setContainer({ width, height });
  };

  return (
    <View className="flex-1 bg-black" onLayout={onLayout}>
      <StatusBar hidden style="light" />
      {watching && <KeepAwake />}

      {watching && (
        <View
          accessibilityLabel="Your PC screen"
          pointerEvents="none"
          style={{
            position: "absolute",
            left: frame.left,
            top: frame.top,
            width: frame.width,
            height: frame.height,
          }}
        >
          <StreamViewerView style={{ flex: 1 }} />
        </View>
      )}

      {live && (
        <View
          className="absolute inset-0"
          accessibilityHint="Pinch to zoom, drag to move, double tap to reset. Only changes your view."
          {...gestures.panHandlers}
        />
      )}

      {!live && (
        <View
          className="absolute inset-0 items-center justify-center bg-black"
          style={{
            paddingLeft: insets.left + 24,
            paddingRight: insets.right + 24,
          }}
        >
          <View className="w-full max-w-md items-center gap-3">
            <Text
              accessibilityRole="header"
              className="text-center text-2xl font-bold text-white"
            >
              {message.title}
            </Text>
            {message.detail ? (
              <Text className="text-center text-base leading-6 text-muted-foreground">
                {message.detail}
              </Text>
            ) : null}
            {session.error ? (
              <Text
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                className="text-center text-sm leading-5 text-destructive"
              >
                {session.error}
              </Text>
            ) : null}
            {!watching && (
              <Button
                variant="outline"
                className="mt-3 min-w-40"
                onPress={session.stop}
              >
                <Text>Back</Text>
              </Button>
            )}
          </View>
        </View>
      )}

      {showControls && watching && (
        <View
          pointerEvents="box-none"
          className="absolute inset-0 justify-between"
          style={{
            paddingTop: insets.top + 12,
            paddingBottom: insets.bottom + 12,
            paddingLeft: insets.left + 12,
            paddingRight: insets.right + 12,
          }}
        >
          <View
            pointerEvents="box-none"
            className="flex-row items-center gap-3"
          >
            <ControlButton
              icon="close"
              label="Stop watching"
              tone="danger"
              onPress={session.stop}
            />
            {live && stats ? (
              <View className="rounded-full bg-black/60 px-3 py-1.5">
                <Text className="text-xs text-white/80">
                  {`${stats.width}×${stats.height} · ${Number(stats.fps).toFixed(0)} fps · ${Number(stats.mbps).toFixed(1)} Mbps`}
                </Text>
              </View>
            ) : null}
          </View>
          {live && (
            <View
              pointerEvents="box-none"
              className="flex-row justify-end gap-3"
            >
              {!isReset(clamped) && (
                <ControlButton
                  icon="scan-outline"
                  label="Reset zoom"
                  onPress={() => setViewport(initialViewport(clamped.mode))}
                />
              )}
              <ControlButton
                icon={
                  clamped.mode === "fit" ? "expand-outline" : "contract-outline"
                }
                label={clamped.mode === "fit" ? "Fill screen" : "Fit screen"}
                onPress={() => setViewport(toggleMode(clamped))}
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}
