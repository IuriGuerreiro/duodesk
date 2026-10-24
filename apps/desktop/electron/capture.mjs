/*
 * Screen capture is a video-only grant to our own window while a desktop-to-phone session is open.
 * Chromium asks for it in three steps: `media` permission checks, a `media` request with no
 * media types (display capture), then the display media request itself.
 */
const sharing = ({ window, entry, active }, contents, frame, url) =>
  active?.direction === "desktop-to-phone" &&
  !!window &&
  contents === window.webContents &&
  contents.getURL() === entry &&
  frame === true &&
  url === entry;

export function mayCheckCapture(permission, contents, details, context) {
  return (
    permission === "media" &&
    details.mediaType === "video" &&
    sharing(context, contents, details.isMainFrame, details.requestingUrl)
  );
}

export function mayRequestCapture(permission, contents, details, context) {
  return (
    permission === "media" &&
    details.mediaTypes?.length === 0 &&
    sharing(context, contents, details.isMainFrame, details.requestingUrl)
  );
}

export function mayCapture(request, { window, entry, active }) {
  const frame = request.frame;
  return (
    active?.direction === "desktop-to-phone" &&
    !!frame &&
    frame === window?.webContents.mainFrame &&
    frame.url === entry &&
    request.videoRequested &&
    !request.audioRequested
  );
}
