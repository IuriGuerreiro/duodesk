import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mayCapture,
  mayCheckCapture,
  mayRequestCapture,
} from "../electron/capture.mjs";

const entry = "duodesk://app/index.html";
const mainFrame = { url: entry };
const window = { webContents: { mainFrame }, isDestroyed: () => false };
const request = {
  frame: mainFrame,
  videoRequested: true,
  audioRequested: false,
  userGesture: true,
};
const active = {
  sessionId: "a".repeat(32),
  direction: "desktop-to-phone",
  captureApproved: true,
};
const context = { window, entry, active };

test("capture is allowed only for the app window during a share session", () => {
  assert.equal(mayCapture(request, context), true);
  assert.equal(mayCapture(request, { ...context, active: undefined }), false);
  assert.equal(
    mayCapture(request, {
      ...context,
      active: { ...active, direction: "phone-to-desktop" },
    }),
    false,
  );
  assert.equal(mayCapture(request, { ...context, window: undefined }), false);
});

test("capture rejects other frames, audio and no video", () => {
  for (const changed of [
    { frame: { url: entry } },
    { frame: { ...mainFrame, url: "https://example.com/" } },
    { frame: null },
    { audioRequested: true },
    { videoRequested: false },
  ])
    assert.equal(mayCapture({ ...request, ...changed }, context), false);
  const moved = { url: "https://example.com/" };
  assert.equal(
    mayCapture(
      { ...request, frame: moved },
      { ...context, window: { webContents: { mainFrame: moved } } },
    ),
    false,
  );
});

const contents = { mainFrame, getURL: () => entry };
const shareWindow = { webContents: contents };
const shareContext = { window: shareWindow, entry, active };
const details = { isMainFrame: true, requestingUrl: entry };

test("display capture permissions are video-only and limited to a share session", () => {
  const check = { ...details, mediaType: "video" };
  const display = { ...details, mediaTypes: [] };
  assert.equal(mayCheckCapture("media", contents, check, shareContext), true);
  assert.equal(
    mayRequestCapture("media", contents, display, shareContext),
    true,
  );
  for (const changed of [
    { active: undefined },
    { active: { ...active, direction: "phone-to-desktop" } },
    { window: undefined },
  ]) {
    const context = { ...shareContext, ...changed };
    assert.equal(mayCheckCapture("media", contents, check, context), false);
    assert.equal(mayRequestCapture("media", contents, display, context), false);
  }
});

test("camera, microphone and other permissions stay denied during a share", () => {
  const check = { ...details, mediaType: "video" };
  assert.equal(
    mayCheckCapture(
      "media",
      contents,
      { ...check, mediaType: "audio" },
      shareContext,
    ),
    false,
  );
  assert.equal(
    mayRequestCapture(
      "media",
      contents,
      { ...details, mediaTypes: ["video"] },
      shareContext,
    ),
    false,
  );
  assert.equal(
    mayRequestCapture(
      "media",
      contents,
      { ...details, mediaTypes: ["audio"] },
      shareContext,
    ),
    false,
  );
  for (const permission of ["geolocation", "notifications", "clipboard-read"]) {
    assert.equal(
      mayCheckCapture(permission, contents, check, shareContext),
      false,
    );
    assert.equal(
      mayRequestCapture(
        permission,
        contents,
        { ...details, mediaTypes: [] },
        shareContext,
      ),
      false,
    );
  }
  assert.equal(
    mayRequestCapture(
      "media",
      contents,
      { ...details, mediaTypes: [], isMainFrame: false },
      shareContext,
    ),
    false,
  );
  assert.equal(
    mayRequestCapture(
      "media",
      contents,
      { ...details, mediaTypes: [], requestingUrl: "https://example.com/" },
      shareContext,
    ),
    false,
  );
});

test("a paired share session can capture without another desktop click", () => {
  assert.equal(mayCapture({ ...request, userGesture: false }, context), true);
  assert.equal(
    mayCapture(
      { ...request, userGesture: false },
      { ...context, active: undefined },
    ),
    false,
  );
});

test("a desktop-to-phone direction without host approval never authorizes capture", () => {
  const unapproved = {
    ...context,
    active: { sessionId: active.sessionId, direction: "desktop-to-phone" },
  };
  assert.equal(mayCapture(request, unapproved), false);
});
