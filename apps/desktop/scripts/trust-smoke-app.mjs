import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { once } from "node:events";
import { createInterface } from "node:readline";
import path from "node:path";
import { createPairingClient } from "../../../packages/protocol/src/pairing.ts";
import { trustProofBytes } from "../../../packages/protocol/src/trust.ts";
import { openPinnedWebSocket as trustedPeer } from "../test/tls-websocket.mjs";
import "../electron/main.mjs";
const directory = process.env.DUODESK_TRUST_SMOKE_DIR;
assert.ok(directory, "Run through trust-smoke.mjs");
app.setPath("userData", directory);
const privateKey = createPrivateKey(process.env.DUODESK_TRUST_SMOKE_KEY);
const publicJwk = createPublicKey(privateKey).export({ format: "jwk" });
const publicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(publicJwk.x, "base64url"),
  Buffer.from(publicJwk.y, "base64url"),
]).toString("hex");
const phoneId = createHash("sha256")
  .update(Buffer.from(publicKey, "hex"))
  .digest("hex");
const phase = process.argv.at(-1);
const deadline = setTimeout(() => app.exit(1), 40000);
let peer;
async function waitFor(action, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await action();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
void app.whenReady().then(async () => {
  try {
    const window = await waitFor(() => {
      const win = BrowserWindow.getAllWindows()[0];
      return win && !win.webContents.isLoading() ? win : null;
    }, "Renderer did not load");
    const evaluate = (expression) =>
      window.webContents.executeJavaScript(expression, true);
    const command = (method, args) =>
      evaluate(
        `window.duoDesk.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`,
      );
    const click = (text) =>
      evaluate(
        `([...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)}) ?? (()=>{throw Error('Missing button')})()).click()`,
      );
    const initial = await command("trust_status");
    assert.equal(initial.enabled, false);
    await evaluate("document.querySelector('.trust-menu details').open = true");
    const ip = (await command("stream_interfaces")).find(
      (item) => item.selectable,
    )?.address;
    assert.ok(ip);
    if (phase === "insecure") {
      assert.equal(initial.available, false);
      await assert.rejects(command("trust_allow", { ip, allow: true }));
      const ordinary = await command("stream_start", { ip });
      assert.equal(ordinary.invitation.fingerprint.length, 64);
      await command("stream_stop");
      await assert.rejects(
        readFile(path.join(directory, "trusted-devices.enc")),
        { code: "ENOENT" },
      );
      console.log(
        JSON.stringify({
          insecureStorageRefused: true,
          ordinaryPairingAvailable: true,
        }),
      );
      clearTimeout(deadline);
      app.quit();
      return;
    }
    assert.equal(initial.available, true, initial.reason);
    if (phase === "enroll") {
      await waitFor(
        () => evaluate("document.querySelector('select')?.options.length > 1"),
        "No interfaces",
      );
      await evaluate(
        `(()=>{const select=document.querySelector('select');select.value=${JSON.stringify(ip)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await click("Create connection");
      const pairing = await waitFor(
        () =>
          evaluate(
            `(()=>{const code=document.querySelector('.code-pairing strong')?.textContent;const address=document.querySelector('[aria-label="Desktop address and port"]')?.textContent;return code&&address?{code,address}:null})()`,
          ),
        "No pairing code",
      );
      const [host, port] = pairing.address.split(":");
      const socket = net.connect({ host, port: Number(port) });
      await once(socket, "connect");
      const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
      const client = createPairingClient(pairing.code, pairing.address);
      socket.write(client.hello + "\n");
      socket.write((await client.challenge((await lines.next()).value)) + "\n");
      const invitation = JSON.parse(
        await client.finish((await lines.next()).value),
      );
      socket.destroy();
      peer = await trustedPeer(invitation.url, invitation.fingerprint);
      peer.send({
        v: 1,
        sessionId: invitation.sessionId,
        type: "pair",
        token: invitation.token,
      });
      assert.equal((await peer.next()).type, "paired");
      peer.send({
        v: 1,
        sessionId: invitation.sessionId,
        type: "trust_enroll",
        phoneId,
        name: "Trust smoke phone",
        publicKey,
      });
      await waitFor(
        () =>
          evaluate(
            "document.body.innerText.includes('Remember Trust smoke phone?') && !document.querySelector('.pairing-modal')",
          ),
        "Approval hidden or absent",
      );
      await click("Remember phone");
      const committed = await peer.next();
      assert.equal(committed.type, "trust_committed");
      assert.equal(committed.phoneId, phoneId);
      assert.equal(committed.fingerprint, invitation.fingerprint);
      await waitFor(
        () =>
          evaluate(
            "[...document.querySelectorAll('button')].some(button=>button.textContent==='Revoke')",
          ),
        "Approved phone absent",
      );
      const status = await command("trust_status");
      assert.equal(status.devices.length, 1);
      const encrypted = await readFile(
        path.join(directory, "trusted-devices.enc"),
      );
      assert.equal(encrypted.includes(Buffer.from("privateKeyDer")), false);
      await writeFile(
        path.join(directory, "smoke-public.json"),
        JSON.stringify({
          fingerprint: invitation.fingerprint,
          address: committed.address,
          phoneId,
        }),
      );
      peer.close();
      await command("stream_stop");
      console.log(
        JSON.stringify({
          trustedUiEnrollment: true,
          encryptedStore: true,
          defaultOff: true,
        }),
      );
    } else {
      const saved = JSON.parse(
        await readFile(path.join(directory, "smoke-public.json"), "utf8"),
      );
      assert.equal(initial.fingerprint, saved.fingerprint);
      assert.equal(initial.devices[0]?.phoneId, phoneId);
      await evaluate(
        `(()=>{const select=document.querySelector('select');select.value=${JSON.stringify(ip)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await waitFor(
        () =>
          evaluate("!document.querySelector('.trust-toggle input')?.disabled"),
        "Reconnect toggle disabled",
      );
      await evaluate("document.querySelector('.trust-toggle input').click()");
      const enabled = await waitFor(async () => {
        const status = await command("trust_status");
        return status.enabled ? status : null;
      }, "Reconnect not enabled");
      peer = await trustedPeer(`wss://${enabled.address}/`, saved.fingerprint);
      peer.send({ v: 1, type: "trust_connect", phoneId });
      const challenge = await peer.next();
      assert.equal(challenge.type, "trust_challenge");
      peer.send({
        v: 1,
        type: "trust_proof",
        phoneId,
        signature: sign(
          "sha256",
          trustProofBytes(challenge.nonce, saved.fingerprint, phoneId),
          privateKey,
        ).toString("hex"),
      });
      const response = await peer.next();
      assert.equal(response.type, "trust_invitation");
      peer.close();
      peer = await trustedPeer(response.invitation.url, saved.fingerprint);
      peer.send({
        v: 1,
        sessionId: response.invitation.sessionId,
        type: "pair",
        token: response.invitation.token,
      });
      assert.equal((await peer.next()).type, "paired");
      await waitFor(
        () =>
          evaluate(
            "document.querySelector('.trust-banner')?.textContent.includes('Trust smoke phone reconnected automatically')",
          ),
        "Visible reconnect notice absent",
      );
      await click("Revoke");
      await waitFor(
        async () => (await command("trust_status")).devices.length === 0,
        "Revoke failed",
      );
      peer.close();
      peer = await trustedPeer(`wss://${enabled.address}/`, saved.fingerprint);
      peer.send({ v: 1, type: "trust_connect", phoneId });
      assert.equal(await peer.next(), null);
      peer.close();
      await command("stream_stop");
      await command("trust_allow", { ip, allow: false });
      console.log(
        JSON.stringify({
          trustedUiRestart: true,
          stableIdentity: true,
          reconnectWithoutCode: true,
          visibleNotice: true,
          revokeRejected: true,
        }),
      );
    }
    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    peer?.close();
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
