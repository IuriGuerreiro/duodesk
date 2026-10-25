import { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Text } from "@/shared/ui/text";
import type { SavedDesktop } from "../../../modules/test-video";
import type { ReconnectState } from "./reconnect";

type Props = {
  desktops: SavedDesktop[];
  state: ReconnectState;
  busy: boolean;
  error: string;
  reconnect: (desktop: SavedDesktop, address: string) => void;
  forget: (fingerprint: string) => void;
  cancel: () => void;
  reload: () => Promise<void>;
};

function DesktopRow({
  desktop,
  control,
}: {
  desktop: SavedDesktop;
  control: Props;
}) {
  const [address, setAddress] = useState(desktop.address);
  const state: ReconnectState =
    "fingerprint" in control.state &&
    control.state.fingerprint === desktop.fingerprint
      ? control.state
      : { kind: "idle" };
  const running = state.kind === "connecting" || state.kind === "waiting";
  return (
    <View className="gap-3 border-t border-border pt-4">
      <Text className="font-semibold">
        Desktop · {desktop.fingerprint.slice(0, 12)}
      </Text>
      <Text
        accessibilityLiveRegion="polite"
        className={
          (state.kind === "failed" && state.terminal) || !desktop.keyAvailable
            ? "text-sm font-semibold text-destructive"
            : "text-sm font-semibold text-muted-foreground"
        }
      >
        {!desktop.keyAvailable || (state.kind === "failed" && state.terminal)
          ? "Needs re-pairing"
          : state.kind === "connecting"
            ? "Connecting"
            : "Offline"}
      </Text>
      <Input
        accessibilityLabel={`Last address for desktop ${desktop.fingerprint.slice(0, 12)}`}
        value={address}
        onChangeText={setAddress}
        editable={!control.busy}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="192.168.1.20:42889"
      />
      <Text className="text-xs leading-5 text-muted-foreground">
        Last local address. Update it if the PC moved networks. Reconnect
        verifies the saved identity.
      </Text>
      {!desktop.keyAvailable && (
        <Text
          accessibilityRole="alert"
          className="text-sm leading-5 text-destructive"
        >
          The phone key is missing. Forget this desktop and explicitly pair
          again with a new code.
        </Text>
      )}
      {state.kind === "failed" && (
        <Text
          accessibilityRole="alert"
          className="text-sm leading-5 text-destructive"
        >
          {state.message}
          {state.terminal
            ? " Automatic retries stopped."
            : " Automatic retries exhausted."}
        </Text>
      )}
      {state.kind === "cancelled" && (
        <Text className="text-sm text-muted-foreground">
          Reconnect cancelled.
        </Text>
      )}
      {running && (
        <View
          className="flex-row items-center gap-2"
          accessibilityLiveRegion="polite"
        >
          <ActivityIndicator color="#3B82F6" />
          <Text className="flex-1 text-sm leading-5 text-muted-foreground">
            {state.kind === "waiting"
              ? `Cannot reach the PC. Retrying in ${state.delayMs / 1000} seconds…`
              : "Verifying saved access…"}
          </Text>
        </View>
      )}
      <View className="flex-row gap-2">
        {running ? (
          <Button className="flex-1" variant="outline" onPress={control.cancel}>
            <Text>Cancel</Text>
          </Button>
        ) : (
          <Button
            className="flex-1"
            disabled={control.busy || !desktop.keyAvailable || !address.trim()}
            onPress={() => control.reconnect(desktop, address)}
          >
            <Text>{state.kind === "failed" ? "Retry" : "Reconnect"}</Text>
          </Button>
        )}
        <Button
          variant="outline"
          disabled={control.busy}
          onPress={() => control.forget(desktop.fingerprint)}
        >
          <Text>Forget</Text>
        </Button>
      </View>
    </View>
  );
}

export function SavedDesktopsPanel(control: Props) {
  if (!control.error && control.desktops.length === 0) return null;
  return (
    <View className="gap-4 rounded-3xl bg-background p-5">
      <Text accessibilityRole="header" className="text-lg font-semibold">
        Saved desktops
      </Text>
      <Text className="text-sm leading-5 text-muted-foreground">
        Turn on Allow reconnects in DuoDesk on your PC. Reconnecting only
        connects the devices. You choose when to share.
      </Text>
      {control.error ? (
        <View className="gap-3">
          <Text className="font-semibold text-destructive">
            Needs re-pairing
          </Text>
          <Text
            accessibilityRole="alert"
            className="text-sm leading-5 text-destructive"
          >
            {control.error}
          </Text>
          <Button
            variant="outline"
            disabled={control.busy}
            onPress={() => void control.reload()}
          >
            <Text>Retry loading</Text>
          </Button>
        </View>
      ) : null}
      {control.desktops.map((desktop) => (
        <DesktopRow
          key={`${desktop.fingerprint}:${desktop.address}`}
          desktop={desktop}
          control={control}
        />
      ))}
    </View>
  );
}
