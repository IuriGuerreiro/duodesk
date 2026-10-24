import { useState } from "react";
import { ReceiverWorkspace, useReceiverSession } from "@/features/receiver";
import {
  ScreenShareWorkspace,
  useScreenShareSession,
} from "@/features/screen-share";
import "./App.css";

type Mode = "receive" | "share";

function Receive({ onShareScreen }: { onShareScreen: () => void }) {
  return (
    <ReceiverWorkspace
      {...useReceiverSession()}
      onShareScreen={onShareScreen}
    />
  );
}

function Share({ onReceive }: { onReceive: () => void }) {
  return (
    <ScreenShareWorkspace {...useScreenShareSession()} onReceive={onReceive} />
  );
}

export default function App() {
  const [mode, setMode] = useState<Mode>("receive");
  return mode === "receive" ? (
    <Receive onShareScreen={() => setMode("share")} />
  ) : (
    <Share onReceive={() => setMode("receive")} />
  );
}
