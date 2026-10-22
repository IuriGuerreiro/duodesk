import { createRef, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import { ControlLink } from "../src/features/remote-control/control-link";
import {
  ControlSurface,
  useControlView,
} from "../src/features/remote-control/control-surface";
import "../src/App.css";

function Player({
  link,
  videoRef,
}: {
  link: ControlLink;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const view = useControlView(link);
  return (
    <div style={{ margin: "100px 70px", width: 600 }}>
      <div className="video-stage has-video" style={{ height: 400 }}>
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          controls={view.phase !== "active"}
        />
        <ControlSurface link={link} videoRef={videoRef} />
      </div>
    </div>
  );
}

const until = async (predicate: () => boolean, message: string) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(message);
};

Object.assign(window, {
  async runControlSurface() {
    const sessionId = "d".repeat(32);
    // A real ControlLink receives the same status messages as it does from the phone.
    const videoRef = createRef<HTMLVideoElement>();
    const root = createRoot(document.querySelector("#root")!);
    const canvas = document.createElement("canvas");
    canvas.width = 360;
    canvas.height = 800;
    const context = canvas.getContext("2d")!;
    let frame = 0;
    const drawing = setInterval(() => {
      context.fillStyle = `hsl(${frame++ % 360} 70% 35%)`;
      context.fillRect(0, 0, 360, 800);
    }, 33);
    const media = canvas.captureStream(30);
    // Deliver a status through the channel callback registered by the production link.
    const channels: RTCDataChannel[] = [];
    const testPeer = new RTCPeerConnection();
    const createChannel = testPeer.createDataChannel.bind(testPeer);
    testPeer.createDataChannel = (...args) => {
      const channel = createChannel(...args);
      channels.push(channel);
      return channel;
    };
    const activeLink = new ControlLink(testPeer, sessionId);
    root.render(<Player link={activeLink} videoRef={videoRef} />);
    await until(() => !!videoRef.current, "Video did not mount");
    const video = videoRef.current!;
    video.srcObject = media;
    await video.play();
    try {
      channels[0].dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            v: 1,
            sessionId,
            type: "status",
            epoch: 1,
            state: "on",
            geometry: { width: 1080, height: 2400, rotation: 0 },
          }),
        }),
      );
      await until(
        () => !!document.querySelector(".control-surface"),
        "Control layer did not appear",
      );
      const check = () => {
        const layer = document
          .querySelector(".control-surface")!
          .getBoundingClientRect();
        const box = video.getBoundingClientRect();
        const width = (box.height * 360) / 800;
        if (
          Math.abs(layer.left - (box.left + (box.width - width) / 2)) > 1 ||
          Math.abs(layer.top - box.top) > 1 ||
          Math.abs(layer.width - width) > 1 ||
          Math.abs(layer.height - box.height) > 1
        )
          throw new Error(
            `Control layer is offset: ${JSON.stringify({ layer: layer.toJSON(), video: box.toJSON() })}`,
          );
        if (
          document.elementFromPoint(
            layer.left + layer.width / 2,
            layer.top + layer.height / 2,
          )?.className !== "control-surface"
        )
          throw new Error("Control layer does not receive picture input");
        if (
          document.elementFromPoint(box.left + 5, box.top + 5)?.className ===
          "control-surface"
        )
          throw new Error("Control layer covers letterbox margins");
      };
      check();
      if (video.controls) throw new Error("Player controls did not step aside");
      const before = video.getVideoPlaybackQuality().totalVideoFrames;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (
        video.paused ||
        video.getVideoPlaybackQuality().totalVideoFrames <= before
      )
        throw new Error("Playback stopped while control was enabled");
      const stage = video.parentElement!;
      stage.style.height = "500px";
      await until(
        () =>
          document.querySelector(".control-surface")!.getBoundingClientRect()
            .height === 500,
        "Control layer did not follow resize",
      );
      check();
      return {
        passed: true,
        offsetStage: true,
        letterboxing: true,
        resize: true,
        playbackContinues: true,
      };
    } finally {
      clearInterval(drawing);
      media.getTracks().forEach((track) => track.stop());
      activeLink.close();
      testPeer.close();
      root.unmount();
    }
  },
});
