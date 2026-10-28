import { RememberedProvider } from "@/features/remembered";
import "@/shared/global.css";
import { colors } from "@duodesk/design-tokens";
import { SenderSessionProvider } from "@/features/stream-sender";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SenderSessionProvider>
        <RememberedProvider>
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          />
        </RememberedProvider>
      </SenderSessionProvider>
    </SafeAreaProvider>
  );
}
