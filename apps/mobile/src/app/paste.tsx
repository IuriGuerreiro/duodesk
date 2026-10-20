import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { parseInvitation } from "@duodesk/protocol";
import { colors } from "@duodesk/design-tokens";
import { Action, styles } from "@/components/duo-ui";
import { connectWith } from "@/lib/session";

export default function PasteScreen() {
  const [invitation, setInvitation] = useState("");
  const [error, setError] = useState("");

  function submit() {
    try {
      parseInvitation(invitation);
    } catch {
      setError("That doesn't look like a DuoDesk invitation.");
      return;
    }
    router.back();
    void connectWith(invitation);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Enter invitation</Text>
        <Text style={styles.lead}>
          On your computer, open “Can’t scan? Copy the invitation”, then paste
          it here.
        </Text>
        <TextInput
          style={styles.input}
          multiline
          value={invitation}
          onChangeText={(text) => {
            setInvitation(text);
            setError("");
          }}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Paste invitation"
          placeholderTextColor={colors.text3}
          accessibilityLabel="Desktop invitation"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.spacer} />
        <Action label="Connect" disabled={!invitation} onPress={submit} />
        <Action variant="ghost" label="Back" onPress={() => router.back()} />
      </ScrollView>
    </SafeAreaView>
  );
}
