import { app, BrowserWindow } from "electron";
import { createServer } from "vite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deadline = setTimeout(() => {
  console.error("Recovery smoke timeout");
  app.exit(1);
}, 30_000);
let server;
app
  .whenReady()
  .then(async () => {
    server = await createServer({
      cacheDir: await mkdtemp(join(tmpdir(), "duodesk-recovery-vite-")),
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const port = server.httpServer.address().port;
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await window.loadURL(`http://127.0.0.1:${port}/test/recovery.html`);
    const result = await window.webContents.executeJavaScript(
      "window.runRecovery()",
    );
    console.log(JSON.stringify(result));
    await server.close();
    clearTimeout(deadline);
    app.exit(result.passed ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await server?.close();
    clearTimeout(deadline);
    app.exit(1);
  });
