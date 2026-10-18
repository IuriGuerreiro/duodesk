import { useState } from "react";
import { ReceiverWorkspace, useReceiverSession } from "@/features/receiver";
import {
  ScreenShareWorkspace,
  useScreenShareSession,
} from "@/features/screen-share";
import "./App.css";

type Mode = "receive" | "share";

const modes: { id: Mode; label: string }[] = [
  { id: "receive", label: "Receive from phone" },
  { id: "share", label: "Share this screen" },
];

function Receive() {
  return <ReceiverWorkspace {...useReceiverSession()} />;
}

function Share() {
  return <ScreenShareWorkspace {...useScreenShareSession()} />;
}

/** Switching modes unmounts the other one, which ends its session. */
export default function App() {
  const [mode, setMode] = useState<Mode>("receive");
  return (
    <>
      <nav className="mode-switch" aria-label="Session type">
        {modes.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {mode === "receive" ? <Receive /> : <Share />}
    </>
  );
}
