import { useEffect } from "react";
import { router } from "expo-router";
import { PairingManual } from "@/features/pairing";
import { useSenderConnection } from "@/features/stream-sender";

export default function ManualEntryScreen() {
  const connection = useSenderConnection();
  const { closeScanner, canPair, busy } = connection;
  useEffect(() => () => closeScanner(), [closeScanner]);
  useEffect(() => {
    if (!canPair || busy) router.dismissTo("/");
  }, [canPair, busy]);
  return <PairingManual connection={connection} onBack={() => router.back()} />;
}
