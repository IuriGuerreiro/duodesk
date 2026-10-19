import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { takeInvitation } from "@/features/pairing";
import * as viewer from "../../../modules/test-video";
import type { ViewerStatus } from "../../../modules/test-video";

export function useViewerSession() {
  const router = useRouter();
  const [status, setStatus] = useState<ViewerStatus>({ state: "idle" });
  const [error, setError] = useState("");

  useEffect(() => {
    const subscription = viewer.subscribeViewer(setStatus);
    const invitation = takeInvitation();
    if (invitation) {
      viewer.watch(invitation).catch((cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not start watching. Try again.",
        );
      });
    }
    return () => {
      subscription.remove();
      void viewer.stopWatching();
    };
  }, []);

  return {
    status,
    error: error || (status.state === "failed" ? (status.message ?? "") : ""),
    stop: () => {
      void viewer.stopWatching();
      router.back();
    },
  };
}
