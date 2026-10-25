import "@/shared/global.css";
import { SenderSessionProvider } from "@/features/stream-sender";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SenderSessionProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: "#0A0A0B" },
          }}
        />
      </SenderSessionProvider>
    </SafeAreaProvider>
  );
}
