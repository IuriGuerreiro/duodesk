// Run with Electron, never node. Shares this machine's real screen through the shipped app
// to a stand-in phone: Node does pairing and signaling, a hidden Chromium window decodes.
// Needs a display and a LAN interface, and builds first (`pnpm build`).
import { app, BrowserWindow } from "electron";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { createInterface } from "node:readline";
import "../electron/main.mjs";
import { createPairingClient } from "../../../packages/protocol/src/pairing.ts";

const deadline = setTimeout(() => {
  console.error("Sender smoke timeout");
  app.exit(1);
}, 60000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Just enough RFC 6455 client for small text messages from a pinned self-signed server. */
async function connectSocket(invitation) {
  const url = new URL(invitation.url);
  const socket = tls.connect({
    host: url.hostname,
    port: Number(url.port),
    rejectUnauthorized: false,
  });
  await once(socket, "secureConnect");
  const pin = createHash("sha256")
    .update(socket.getPeerCertificate().raw)
    .digest("hex");
  if (pin !== invitation.fingerprint)
    throw new Error("Certificate pin mismatch");
  socket.write(
    `GET / HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  const messages = [];
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      if (!buffer.subarray(0, 12).toString().includes("101"))
        throw new Error("WebSocket upgrade refused");
      buffer = buffer.subarray(end + 4);
      upgraded = true;
    }
    for (;;) {
      if (buffer.length < 2) return;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) [length, offset] = [buffer.readUInt16BE(2), 4];
      else if (length === 127) {
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (buffer.length < offset + length) return;
      const opcode = buffer[0] & 0x0f;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 1) messages.push(JSON.parse(payload.toString()));
      else if (opcode === 8) messages.push({ type: "closed" });
    }
  });
  return {
    messages,
    send(message) {
      const payload = Buffer.from(JSON.stringify(message));
      const mask = randomBytes(4);
      const header =
        payload.length < 126
          ? Buffer.from([0x81, 0x80 | payload.length])
          : Buffer.from([
              0x81,
              0x80 | 126,
              payload.length >> 8,
              payload.length & 255,
            ]);
      const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
      socket.write(Buffer.concat([header, mask, masked]));
    },
    async next(type, timeout = 15000) {
      for (let waited = 0; waited < timeout; waited += 20) {
        const index = messages.findIndex((message) => message.type === type);
        if (index >= 0) return messages.splice(index, 1)[0];
        await sleep(20);
      }
      throw new Error(`No ${type} message from the desktop`);
    },
    close: () => socket.destroy(),
  };
}

async function pair(address, code) {
  const [host, port] = address.split(":");
  const socket = net.connect({ host, port: Number(port) });
  await once(socket, "connect");
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  const client = createPairingClient(code, address);
  socket.write(client.hello + "\n");
  socket.write((await client.challenge((await lines.next()).value)) + "\n");
  const invitation = JSON.parse(
    await client.finish((await lines.next()).value),
  );
  socket.destroy();
  return invitation;
}

const viewerPage = `
  const pc = new RTCPeerConnection({ iceServers: [] });
  const outbox = [];
  pc.onicecandidate = (e) => e.candidate && outbox.push({ candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex ?? 0 });
  window.drain = () => outbox.splice(0);
  window.accept = async (sdp) => {
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return answer.sdp;
  };
  window.addCandidate = (c) => pc.addIceCandidate(c);
  window.decoded = async () => {
    const report = await pc.getStats();
    let out = null;
    report.forEach((e) => { if (e.type === "inbound-rtp" && e.kind === "video") out = { frames: e.framesDecoded ?? 0, width: e.frameWidth, height: e.frameHeight, codec: report.get(e.codecId)?.mimeType, decoder: e.decoderImplementation }; });
    return out;
  };
  0;
`;

void (async () => {
  let win;
  let viewer;
  let phone;
  try {
    await app.whenReady();
    for (let i = 0; i < 100; i++) {
      win = BrowserWindow.getAllWindows()[0];
      if (
        win &&
        !win.webContents.isLoading() &&
        win.webContents.getURL().startsWith("duodesk://app/index.html")
      )
        break;
      await sleep(100);
    }
    const ui = (source) =>
      win.webContents.executeJavaScript(`(async () => { ${source} })()`, true);
    const helpers = `
      const wait = async (predicate, message) => { for (let i = 0; i < 200; i++) { const value = predicate(); if (value) return value; await new Promise(r => setTimeout(r, 50)); } throw Error(message); };
      const button = text => [...document.querySelectorAll('button')].find(b => b.textContent.includes(text));`;
    const created = await ui(`${helpers}
      button('Share this screen').click();
      await wait(() => document.querySelector('#screen-share'), 'Share workspace did not open');
      const select = await wait(() => [...(document.querySelector('select')?.options ?? [])].some(o => o.value && !o.disabled) && document.querySelector('select'), 'No LAN address');
      await wait(() => {
        select.value = [...select.options].find(o => o.value && !o.disabled).value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return !button('Create connection').disabled;
      }, 'Address not accepted');
      button('Create connection').click();
      const code = await wait(() => document.querySelector('.code-pairing strong'), 'No pairing code');
      const address = document.querySelector('.code-pairing code').textContent;
      return { code: code.textContent, address };`);
    const invitation = await pair(created.address, created.code);
    if (invitation.direction !== "desktop-to-phone")
      throw new Error("Wrong direction: " + invitation.direction);
    await sleep(6000); // Let the Create connection click activation expire.
    phone = await connectSocket(invitation);
    phone.send({
      v: 1,
      sessionId: invitation.sessionId,
      type: "pair",
      token: invitation.token,
    });
    await phone.next("paired");

    viewer = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        partition: "viewer",
      },
    });
    await viewer.loadURL("data:text/html,<title>viewer</title>");
    await viewer.webContents.executeJavaScript(viewerPage);
    const view = (source) => viewer.webContents.executeJavaScript(source);

    // No desktop click after pairing: the offer must arrive automatically.
    const offer = await phone.next("offer");
    const answer = await view(`window.accept(${JSON.stringify(offer.sdp)})`);
    phone.send({
      v: 1,
      sessionId: invitation.sessionId,
      type: "answer",
      sdp: answer,
    });

    const started = Date.now();
    let first;
    let last;
    while (Date.now() - started < 30000) {
      for (const message of phone.messages.splice(0)) {
        if (message.type === "candidate")
          await view(
            `window.addCandidate(${JSON.stringify({ candidate: message.candidate, sdpMid: message.sdpMid, sdpMLineIndex: message.sdpMLineIndex })})`,
          ).catch(() => {});
      }
      for (const candidate of await view("window.drain()"))
        phone.send({
          v: 1,
          sessionId: invitation.sessionId,
          type: "candidate",
          ...candidate,
        });
      last = await view("window.decoded()");
      if (last?.frames > 20 && !first) first = { ...last, at: Date.now() };
      if (first && Date.now() - first.at > 5000) break;
      await sleep(100);
    }
    if (!first || !last || last.frames <= first.frames)
      throw new Error("No decoded frames: " + JSON.stringify(last));
    const fps = ((last.frames - first.frames) / (Date.now() - first.at)) * 1000;
    const label = await ui(
      `${helpers} await wait(() => document.querySelector('[role=status]')?.textContent === 'Sharing your screen', 'UI never showed sharing'); return document.querySelector('.live-stats').textContent;`,
    );

    await ui(
      `${helpers} button('Stop session').click(); await wait(() => document.querySelector('[role=status]').textContent.includes('Session ended'), 'Stop did not end the session');`,
    );
    await phone.next("stop");
    console.log(
      JSON.stringify({
        passed: true,
        direction: invitation.direction,
        codec: last.codec,
        decoder: last.decoder,
        size: `${last.width}x${last.height}`,
        viewerFps: Math.round(fps),
        senderToolbar: label,
      }),
    );
    clearTimeout(deadline);
    app.exit(0);
  } catch (error) {
    console.error(error);
    const alert = await BrowserWindow.getAllWindows()[0]
      ?.webContents.executeJavaScript(
        "document.querySelector('[role=alert]')?.textContent",
      )
      .catch(() => undefined);
    if (alert) console.error("UI error:", alert);
    clearTimeout(deadline);
    app.exit(1);
  } finally {
    phone?.close();
  }
})();
