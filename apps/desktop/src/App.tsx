import { RememberedDevices } from "@/features/remembered";
import type { Direction } from "@duodesk/protocol";
import { useCallback, useState } from "react";
import { ReceiverWorkspace, useReceiverSession } from "@/features/receiver";
import {
  ScreenShareWorkspace,
  useScreenShareSession,
} from "@/features/screen-share";
import "./App.css";

type Mode = "receive" | "share";

function Receive({
  onShareScreen,
  requestId,
}: {
  onShareScreen: () => void;
  requestId?: string;
}) {
  return (
    <ReceiverWorkspace
      {...useReceiverSession(requestId)}
      onShareScreen={onShareScreen}
    />
  );
}

function Share({
  onReceive,
  requestId,
}: {
  onReceive: () => void;
  requestId?: string;
}) {
  return (
    <ScreenShareWorkspace
      {...useScreenShareSession(requestId)}
      onReceive={onReceive}
    />
  );
}

export default function App() {
  const [mode, setMode] = useState<Mode>("receive");
  const [request, setRequest] = useState<{
    direction: Direction;
    id: string;
  }>();
  const startRemembered = useCallback((direction: Direction, id: string) => {
    setRequest({ direction, id });
    setMode(direction === "phone-to-desktop" ? "receive" : "share");
  }, []);
  return (
    <>
      {mode === "receive" ? (
        <Receive
          requestId={
            request?.direction === "phone-to-desktop" ? request.id : undefined
          }
          onShareScreen={() => setMode("share")}
        />
      ) : (
        <Share
          requestId={
            request?.direction === "desktop-to-phone" ? request.id : undefined
          }
          onReceive={() => setMode("receive")}
        />
      )}
      <RememberedDevices onStart={startRemembered} />
    </>
  );
}
