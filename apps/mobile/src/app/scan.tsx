import { useCallback, useEffect } from "react";
import { AppState } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { PairingScanner } from "@/features/pairing";
import { useSenderConnection } from "@/features/stream-sender";

export default function ScanScreen() {
  const connection = useSenderConnection();
  const { openScanner, closeScanner, canPair, busy } = connection;
  useFocusEffect(
    useCallback(() => {
      openScanner();
      return closeScanner;
    }, [openScanner, closeScanner]),
  );
  useEffect(() => {
    if (!canPair || busy) router.dismissTo("/");
  }, [canPair, busy]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") openScanner();
    });
    return () => subscription.remove();
  }, [openScanner]);
  return (
    <PairingScanner
      connection={connection}
      onBack={() => router.back()}
      onManual={() => {
        closeScanner();
        connection.setMode("manual");
        router.replace("/paste");
      }}
    />
  );
}
