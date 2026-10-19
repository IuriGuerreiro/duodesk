// Run alongside `pnpm exec vite --host 127.0.0.1 --port 1422 --strictPort`.
import { app, BrowserWindow } from "electron";
const deadline = setTimeout(() => {
  console.error("Receiver smoke timeout");
  app.exit(1);
}, 30000);
app
  .whenReady()
  .then(async () => {
    const window = new BrowserWindow({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await window.loadURL(
      process.env.DUODESK_RECEIVER_TEST_URL ??
        "http://127.0.0.1:1422/test/loopback.html",
    );
    const result = await window.webContents.executeJavaScript(
      "window.runLoopback()",
    );
    console.log(JSON.stringify(result));
    const audio = await window.webContents.executeJavaScript(
      "window.runAudioLoopback()",
    );
    console.log(JSON.stringify(audio));
    clearTimeout(deadline);
    app.exit(result.passed && audio.passed ? 0 : 1);
  })
  .catch((error) => {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  });
