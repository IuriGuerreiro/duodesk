import { useEffect } from "react";
import { router } from "expo-router";
import { CameraView } from "expo-camera";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSharedSenderSession } from "@/features/stream-sender";
import { Action, styles } from "@/shared/ui/duo-ui";

export default function ScanPairing() {
  const { acceptScan, closeScanner, error } = useSharedSenderSession();
  useEffect(() => closeScanner, [closeScanner]);
  return (
    <View style={styles.scanRoot}>
      <CameraView
        style={StyleSheet.absoluteFill}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (acceptScan(data)) router.back();
        }}
      />
      <SafeAreaView style={styles.scanOverlay}>
        <Text style={styles.scanTitle}>Scan the code on your computer</Text>
        <View style={styles.scanFrame} />
        <View style={styles.scanActions}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Action
            label="Enter address and code"
            variant="secondary"
            onPress={() => router.replace("/paste")}
          />
          <Action
            label="Cancel"
            variant="secondary"
            onPress={() => router.back()}
          />
        </View>
      </SafeAreaView>
    </View>
  );
}
