import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { ControlLink } from "../src/features/remote-control/control-link";
import { ReceiverWorkspace } from "../src/features/receiver/receiver-workspace";
import "../src/App.css";

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
    context.fillStyle = "#333";
    context.fillRect(0, 0, 360, 800);
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
    root.render(
      <div style={{ margin: "100px 70px", width: 600 }}>
        <ReceiverWorkspace
          desktopAvailable
          interfaces={[]}
          ip=""
          state="streaming"
          error=""
          busy={false}
          remaining={0}
          videoRef={videoRef}
          control={activeLink}
          playbackFailed={false}
          audio={{
            present: false,
            muted: true,
            volume: 1,
            blocked: false,
            onMutedChange: () => {},
            onVolumeChange: () => {},
          }}
          onIpChange={() => {}}
          onRefresh={() => {}}
          onStart={() => {}}
          onStop={() => {}}
          onFullscreen={() => {}}
          onPlay={() => {}}
        />
      </div>,
    );
    await until(() => !!videoRef.current, "Video did not mount");
    const video = videoRef.current!;
    const panel = video.closest<HTMLElement>(".receiver-panel")!;
    panel.style.height = "400px";
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
      // The layer takes the wheel so the desktop page does not scroll; margins and Ctrl+wheel do not.
      const layer = document
        .querySelector(".control-surface")!
        .getBoundingClientRect();
      const box = video.getBoundingClientRect();
      const spin = (x: number, y: number, ctrlKey = false) => {
        const event = new WheelEvent("wheel", {
          deltaY: 100,
          clientX: x,
          clientY: y,
          ctrlKey,
          bubbles: true,
          cancelable: true,
        });
        document.elementFromPoint(x, y)!.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const centreX = layer.left + layer.width / 2;
      const centreY = layer.top + layer.height / 2;
      if (!spin(centreX, centreY))
        throw new Error("Wheel over the picture scrolled the desktop");
      if (spin(centreX, centreY, true))
        throw new Error("Ctrl+wheel was taken from the desktop");
      if (spin(box.left + 5, box.top + 5))
        throw new Error("Wheel over the letterbox was taken");
      const toolbar = document
        .querySelector(".live-bar")!
        .getBoundingClientRect();
      const target = document.elementFromPoint(
        toolbar.left + 20,
        toolbar.top + toolbar.height / 2,
      );
      if (!target?.closest(".live-bar"))
        throw new Error(
          `Control layer blocks the floating toolbar: ${target?.outerHTML.slice(0, 120)} ${JSON.stringify(toolbar.toJSON())}`,
        );
      if (
        getComputedStyle(document.querySelector(".control-surface")!)
          .outlineStyle !== "none"
      )
        throw new Error("Decorative control outline returned");
      const before = video.getVideoPlaybackQuality().totalVideoFrames;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (
        video.paused ||
        video.getVideoPlaybackQuality().totalVideoFrames <= before
      )
        throw new Error("Playback stopped while control was enabled");
      panel.style.height = "500px";
      await until(
        () =>
          document.querySelector(".control-surface")!.getBoundingClientRect()
            .height === 500,
        "Control layer did not follow resize",
      );
      check();
      // Phone keyboard: shown only after the phone advertises text for this epoch, then on by default.
      if (document.querySelector(".phone-keyboard"))
        throw new Error("Keyboard shown without text caps");
      channels[0].dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            v: 1,
            sessionId,
            type: "caps",
            epoch: 1,
            text: true,
          }),
        }),
      );
      await until(
        () => document.activeElement?.className === "phone-keyboard-field",
        "Keyboard did not take focus after caps",
      );
      const keyboard = document
        .querySelector(".phone-keyboard")!
        .getBoundingClientRect();
      const bar = document.querySelector(".live-bar")!.getBoundingClientRect();
      if (keyboard.bottom > bar.top)
        throw new Error(
          `Keyboard overlaps the toolbar: ${JSON.stringify({ keyboard: keyboard.toJSON(), bar: bar.toJSON() })}`,
        );
      // Clicking the phone picture keeps keys going to the phone.
      const surface = document.querySelector(".control-surface")!;
      const rect = surface.getBoundingClientRect();
      (document.activeElement as HTMLElement).blur();
      surface.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 10,
          clientY: rect.top + 10,
        }),
      );
      surface.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 10,
          clientY: rect.top + 10,
        }),
      );
      if (document.activeElement?.className !== "phone-keyboard-field")
        throw new Error("Tapping the picture did not focus the keyboard");
      return {
        passed: true,
        keyboard: true,
        offsetStage: true,
        letterboxing: true,
        resize: true,
        playbackContinues: true,
        wheelPrevented: true,
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
