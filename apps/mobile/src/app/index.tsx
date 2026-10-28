import { Link } from "expo-router";
import { View } from "react-native";
import { StreamSenderScreen } from "@/features/stream-sender";
export default function Home() {
  return (
    <View style={{ flex: 1 }}>
      <StreamSenderScreen />
      <Link
        href="/devices"
        style={{ color: "#ddd", padding: 16, backgroundColor: "#161618" }}
      >
        Remembered devices
      </Link>
    </View>
  );
}
