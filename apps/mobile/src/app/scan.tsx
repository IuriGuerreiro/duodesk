import { useRef, useState } from "react";
import { StyleSheet, Text, Vibration, View } from "react-native";
import { router } from "expo-router";
import { CameraView } from "expo-camera";
import { SafeAreaView } from "react-native-safe-area-context";
import { parseInvitation } from "@duodesk/protocol";
import { Action, styles } from "@/components/duo-ui";
import { connectWith } from "@/lib/session";

export default function ScanScreen() {
  const [error, setError] = useState("");
  const done = useRef(false);

  function accept(text: string) {
    if (done.current) return;
    try {
      parseInvitation(text);
    } catch {
      setError("That QR code isn't a DuoDesk code. Try again.");
      return;
    }
    done.current = true;
    Vibration.vibrate(30);
    router.back();
    void connectWith(text);
  }

  return (
    <View style={styles.scanRoot}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => accept(data)}
      />
      <SafeAreaView style={styles.scanOverlay}>
        <Text style={styles.scanTitle}>Scan the code on your computer</Text>
        <View style={styles.scanFrame} />
        {error ? <Text style={styles.scanError}>{error}</Text> : null}
        <View style={styles.scanActions}>
          <Action
            variant="secondary"
            label="Enter invitation instead"
            onPress={() => router.replace("/paste")}
          />
          <Action
            variant="ghost"
            label="Cancel"
            onPress={() => router.back()}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}
