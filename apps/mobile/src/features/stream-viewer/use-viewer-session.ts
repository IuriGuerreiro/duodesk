import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { takeInvitation } from "@/features/pairing";
import * as viewer from "../../../modules/test-video";
import type { ViewerStatus } from "../../../modules/test-video";
import { startViewerSession } from "./viewer-lifecycle";

export function useViewerSession() {
  const router = useRouter();
  const [status, setStatus] = useState<ViewerStatus>({ state: "idle" });
  const [error, setError] = useState("");

  useEffect(
    () =>
      startViewerSession(
        {
          supported: viewer.supportsViewing,
          enterViewerMode: viewer.enterViewerMode,
          exitViewerMode: viewer.exitViewerMode,
          subscribeViewer: viewer.subscribeViewer,
          watch: viewer.watch,
          stopWatching: viewer.stopWatching,
        },
        takeInvitation(),
        { onStatus: setStatus, onError: setError },
      ),
    [],
  );

  return {
    status,
    error: error || (status.state === "failed" ? (status.message ?? "") : ""),
    stop: () => {
      void viewer.stopWatching();
      if (router.canGoBack()) router.back();
      else router.replace("/");
    },
  };
}
