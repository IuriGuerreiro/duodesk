import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  protocol,
  safeStorage,
} from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { mayCapture, mayCheckCapture, mayRequestCapture } from "./capture.mjs";
import { Host, validateCommand } from "./host.mjs";
import { TrustStore } from "./trust-store.mjs";
import { TrustBackend } from "./trust-backend.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = "duodesk://app/index.html";
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "duodesk",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let window;
let host;
let trust;
let commands = Promise.resolve();
function emit(payload) {
  if (payload.kind === "trust_reconnected")
    active = {
      sessionId: payload.invitation.sessionId,
      direction: "phone-to-desktop",
    };
  if (window && !window.isDestroyed())
    window.webContents.send("duodesk:event", payload);
}
let active;
let diagnosticPath;
function diagnostic(event, data = {}) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    event,
    ...data,
  });
  console.info(`[duodesk-debug] ${line}`);
  if (!diagnosticPath) return;
  try {
    if (statSync(diagnosticPath, { throwIfNoEntry: false })?.size > 5_000_000)
      renameSync(diagnosticPath, `${diagnosticPath}.previous`);
    appendFileSync(diagnosticPath, `${line}\n`, { mode: 0o600 });
  } catch (error) {
    console.error("Could not write diagnostics", error.message);
  }
}
app.commandLine.appendSwitch(
  "force-webrtc-ip-handling-policy",
  "default_public_and_private_interfaces",
);
// Send real LAN addresses instead of .local names, which Android senders behind NAT (emulators) cannot resolve.
app.commandLine.appendSwitch(
  "disable-features",
  "WebRtcHideLocalIpsWithMdns",
);
function closeHost() {
  trust?.reset();
  host?.close();
  host = undefined;
  active = undefined;
}
async function open() {
  window = new BrowserWindow({
    width: 1100,
    height: 850,
    webPreferences: {
      preload: path.join(root, "electron/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.on("console-message", (details) => {
    if (details.message.startsWith("[screen-debug] "))
      diagnostic("sender", { message: details.message.slice(15, 16015) });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("render-process-gone", closeHost);
  window.webContents.on("did-start-loading", closeHost);
  window.on("closed", () => {
    closeHost();
    window = undefined;
  });
  await window.loadURL(entry);
}
app
  .whenReady()
  .then(async () => {
    app.setAppLogsPath();
    mkdirSync(app.getPath("logs"), { recursive: true });
    diagnosticPath = path.join(app.getPath("logs"), "screen-share.jsonl");
    diagnostic("environment", {
      logPath: diagnosticPath,
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
      sessionType: process.env.XDG_SESSION_TYPE,
      desktop: process.env.XDG_CURRENT_DESKTOP,
      display: process.env.DISPLAY,
      waylandDisplay: process.env.WAYLAND_DISPLAY,
      gpu: app.getGPUFeatureStatus(),
    });
    const store = new TrustStore(
      path.join(app.getPath("userData"), "trusted-devices.enc"),
      safeStorage,
    );
    await store.load();
    trust = new TrustBackend(store, emit);
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) =>
        callback(
          (permission === "fullscreen" &&
            contents === window?.webContents &&
            contents.getURL() === entry &&
            details.isMainFrame &&
            details.requestingUrl === entry) ||
            mayRequestCapture(permission, contents, details, {
              window,
              entry,
              active,
            }),
        ),
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        (permission === "fullscreen" &&
          contents === window?.webContents &&
          contents?.getURL() === entry &&
          details.isMainFrame &&
          details.requestingUrl === entry) ||
        (!!contents &&
          mayCheckCapture(permission, contents, details, {
            window,
            entry,
            active,
          })),
    );
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        const allowed = mayCapture(request, { window, entry, active });
        diagnostic("capture-request", {
          allowed,
          direction: active?.direction,
          video: request.videoRequested,
          audio: request.audioRequested,
          gesture: request.userGesture,
          mainFrame: request.frame === window?.webContents.mainFrame,
        });
        if (!allowed) return callback(null);
        try {
          const sources = await desktopCapturer.getSources({
            types: ["screen"],
          });
          diagnostic("capture-sources", {
            count: sources.length,
            sources: sources.map((source) => ({
              id: source.id,
              displayId: source.display_id,
            })),
          });
          callback(sources[0] ? { video: sources[0] } : null);
        } catch (error) {
          diagnostic("capture-error", {
            name: error.name,
            message: error.message,
            stack: error.stack,
          });
          callback(null);
        }
      },
      { useSystemPicker: false },
    );
    // Renderer assets are local; signaling belongs exclusively to the Rust host.
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel:
          !details.url.startsWith("duodesk://app/") &&
          !details.url.startsWith("devtools://"),
      }),
    );
    protocol.handle("duodesk", async (request) => {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const target = path.resolve(root, "dist", relative);
      if (
        url.hostname !== "app" ||
        request.method !== "GET" ||
        !target.startsWith(path.join(root, "dist") + path.sep)
      )
        return new Response(null, { status: 403 });
      try {
        const body = await readFile(target);
        const mime =
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
          }[path.extname(target)] ?? "application/octet-stream";
        return new Response(body, {
          headers: {
            "Content-Type": mime,
            "Content-Security-Policy": csp,
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    ipcMain.handle("duodesk:command", async (event, method, args) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== entry
      )
        throw new Error("Untrusted sender");
      validateCommand(method, args, active?.direction);
      const command = async () => {
        if (!host) {
          const binary = path.join(
            app.isPackaged ? process.resourcesPath : root,
            "bin",
            `duodesk-host${process.platform === "win32" ? ".exe" : ""}`,
          );
          const nextHost = new Host(
            binary,
            (payload) => {
              if (host !== nextHost) return;
              if (!trust.onEvent(payload, nextHost)) emit(payload);
            },
            () => {
              if (host !== nextHost) return;
              trust.reset();
              host = undefined;
              trust.changed();
              if (active && window && !window.isDestroyed())
                window.webContents.send("duodesk:event", {
                  kind: "state",
                  sessionId: active.sessionId,
                  state: "failed",
                });
              active = undefined;
            },
          );
          host = nextHost;
        }
        const owner = host;
        if (method === "stream_start") await trust.beforeStart(owner, args.ip);
        const result = method.startsWith("trust_")
          ? await trust.command(owner, method, args)
          : await owner.request(method, args);
        if (owner !== host || owner.closed)
          throw new Error("Desktop host stopped");
        if (method === "stream_start")
          active = {
            sessionId: result.invitation.sessionId,
            direction: args.direction,
          };
        if (method === "stream_stop") active = undefined;
        return result;
      };
      const result = commands.then(command);
      commands = result.catch(() => {});
      return result;
    });
    await open();
    app.on("activate", () => {
      if (!window) void open();
    });
  })
  .catch((error) => {
    console.error(error);
    app.quit();
  });
app.on("before-quit", closeHost);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
