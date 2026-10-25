import { router } from "expo-router";
import { ScrollView, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "@duodesk/design-tokens";
import { useSharedSenderSession } from "@/features/stream-sender";
import { Action, styles } from "@/shared/ui/duo-ui";

export default function ManualPairing() {
  const session = useSharedSenderSession();
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Connect to your computer</Text>
        <Text style={styles.lead}>
          Enter the address and six-digit code shown in DuoDesk on your
          computer.
        </Text>
        <TextInput
          accessibilityLabel="Computer address"
          placeholder="192.168.1.20:42888"
          placeholderTextColor={colors.text3}
          style={[styles.input, { minHeight: 54 }]}
          value={session.address}
          onChangeText={session.setAddress}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TextInput
          accessibilityLabel="Pairing code"
          placeholder="Six-digit code"
          placeholderTextColor={colors.text3}
          style={[styles.input, { minHeight: 54 }]}
          value={session.code}
          onChangeText={session.setCode}
          keyboardType="number-pad"
          maxLength={6}
        />
        <Action
          label="Connect"
          disabled={!session.canSubmit || session.busy}
          onPress={() => {
            session.connect();
            router.back();
          }}
        />
        <Action label="Back" variant="ghost" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
