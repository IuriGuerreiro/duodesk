import { useEffect } from "react";
import { router } from "expo-router";
import { ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSenderConnection } from "@/features/stream-sender";
import { SavedDesktopsPanel } from "@/features/trusted-desktops";
import { Action, styles } from "@/shared/ui/duo-ui";

export default function SavedDesktops() {
  const session = useSenderConnection();
  useEffect(() => {
    if (session.status.state === "ready") router.back();
  }, [session.status.state]);
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <SavedDesktopsPanel
          desktops={session.savedDesktops}
          state={session.reconnectState}
          busy={session.busy}
          error={session.trustError}
          reconnect={(desktop, address) => {
            session.reconnectDesktop(desktop, address);
          }}
          forget={session.forgetDesktop}
          cancel={session.stop}
          reload={session.retrySaved}
        />
        <Action label="Back" variant="ghost" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
