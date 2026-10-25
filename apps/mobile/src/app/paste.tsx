import { useEffect } from "react";
import { router } from "expo-router";
import { PairingManual } from "@/features/pairing";
import { useSenderConnection } from "@/features/stream-sender";

export default function ManualEntryScreen() {
  const connection = useSenderConnection();
  const { closeScanner } = connection;
  useEffect(() => () => closeScanner(), [closeScanner]);
  return <PairingManual connection={connection} onBack={() => router.back()} />;
}
